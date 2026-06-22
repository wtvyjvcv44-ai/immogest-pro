#!/usr/bin/env node
/*
 * maj-indices-insee.js — Vérificateur / mise à jour automatique des indices INSEE.
 *
 * Source de vérité : API officielle INSEE BDM (SDMX), gratuite, sans authentification.
 * Contrôles internes (modèle "INSEE + contrôles", validé le 22/06/2026) :
 *   - on n'accepte QUE les observations marquées DÉFINITIVES (OBS_QUAL="DEF") par l'INSEE ;
 *   - chaque valeur doit avoir une date de publication au Journal Officiel (DATE_JO) non future ;
 *   - garde-fou anti-bug de parsing : on REJETTE toute valeur qui s'écarte de >25 % de la
 *     précédente (impossible pour un indice réel → signe d'une erreur de lecture) ;
 *   - écriture dans Supabase ig_indices UNIQUEMENT si la valeur est nouvelle ou corrigée ;
 *   - toute anomalie n'est PAS écrite et fait échouer le job (→ alerte e-mail GitHub).
 *
 * Usage :
 *   node maj-indices-insee.js --dry-run   (n'écrit rien, affiche ce qui serait fait)
 *   node maj-indices-insee.js             (écrit les valeurs confirmées dans Supabase)
 *
 * Variables d'environnement (avec valeurs par défaut = clé anon publique du projet) :
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 */

'use strict';
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mlghmtxssihdvxgvysjz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sZ2htdHhzc2loZHZ4Z3Z5c2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDMxMDMsImV4cCI6MjA5MTMxOTEwM30.WIi5P5d6t3wAvjVC4dxgPOSInG6zoz72TbuLdYiiEfk';
const DRY_RUN = process.argv.includes('--dry-run');
const START_PERIOD = '2019-01'; // on (re)vérifie l'historique récent (couvre les corrections)

// Séries INSEE BDM (idBank vérifiés le 22/06/2026). type : 'T' trimestriel, 'M' mensuel.
const SERIES = [
  { indice: 'ILC',  idBank: '001532540', type: 'T' },
  { indice: 'ILAT', idBank: '001617112', type: 'T' },
  { indice: 'IRL',  idBank: '001515333', type: 'T' },
  { indice: 'ICC',  idBank: '000008630', type: 'T' },
  { indice: 'BT01', idBank: '001710986', type: 'M' },
];

const SEUIL_ABERRATION = 0.25; // 25 % : au-delà = erreur de parsing présumée

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/xml' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    https.get(SUPABASE_URL + '/rest/v1/' + path,
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d || '[]')); } catch (e) { reject(e); } }); }
    ).on('error', reject);
  });
}

function supabaseUpsert(row) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(row);
    const u = new URL(SUPABASE_URL + '/rest/v1/ig_indices');
    const req = https.request(u, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Parse les <Obs .../> d'une réponse SDMX StructureSpecific.
function parseObs(xml) {
  const obs = [];
  const re = /<(?:\w+:)?Obs\s+([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const tp = /TIME_PERIOD="([^"]*)"/.exec(a);
    const v = /OBS_VALUE="([^"]*)"/.exec(a);
    const q = /OBS_QUAL="([^"]*)"/.exec(a);
    const jo = /DATE_JO="([^"]*)"/.exec(a);
    if (tp && v) obs.push({ periode: tp[1], valeur: parseFloat(v[1]), qual: q ? q[1] : '', dateJo: jo ? jo[1] : '' });
  }
  return obs;
}

// "2026-Q1" → "1T2026" ; "2026-04" → "2026-04"
function toKey(periode) {
  const q = /^(\d{4})-Q([1-4])$/.exec(periode);
  if (q) return q[2] + 'T' + q[1];
  const mo = /^(\d{4})-(\d{2})$/.exec(periode);
  if (mo) return periode;
  return null;
}

function ordre(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return parseInt(m[1], 10) * 12 + (parseInt(m[2], 10) - 1);
  const t = /^([1-4])T(\d{4})$/.exec(key);
  if (t) return parseInt(t[2], 10) * 12 + (parseInt(t[1], 10) - 1) * 3 + 2;
  return -1;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  let nbEcrits = 0, nbInchanges = 0;
  const anomalies = [];
  console.log('=== Vérificateur indices INSEE ' + (DRY_RUN ? '(DRY-RUN — aucune écriture)' : '(écriture réelle)') + ' ===');

  for (const s of SERIES) {
    const url = 'https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/' + s.idBank + '?startPeriod=' + START_PERIOD;
    let resp;
    try { resp = await httpGet(url); } catch (e) { anomalies.push(s.indice + ' : échec réseau INSEE (' + e.message + ')'); continue; }
    if (resp.status !== 200) { anomalies.push(s.indice + ' : INSEE HTTP ' + resp.status); continue; }

    let obs = parseObs(resp.body)
      .map(o => ({ key: toKey(o.periode), valeur: o.valeur, qual: o.qual, dateJo: o.dateJo }))
      .filter(o => o.key && !isNaN(o.valeur) && o.valeur > 0)
      .sort((a, b) => ordre(a.key) - ordre(b.key));

    if (!obs.length) { anomalies.push(s.indice + ' : aucune observation lue (parsing ?)'); continue; }

    // Valeurs actuellement en base
    const existant = {};
    try {
      const rows = await supabaseGet('ig_indices?indice=eq.' + s.indice + '&select=periode,valeur');
      rows.forEach(r => { existant[r.periode] = parseFloat(r.valeur); });
    } catch (e) { anomalies.push(s.indice + ' : lecture Supabase échouée (' + e.message + ')'); continue; }

    let prev = null;
    for (const o of obs) {
      // Contrôle 1 : définitif uniquement
      if (o.qual !== 'DEF') { prev = o; continue; }
      // Contrôle 2 : date JO présente et non future
      if (!o.dateJo || o.dateJo > today) { anomalies.push(s.indice + ' ' + o.key + ' : DATE_JO absente ou future (' + o.dateJo + ')'); prev = o; continue; }
      // Contrôle 3 : anti-aberration (écart > 25 % vs précédent = erreur de parsing présumée)
      if (prev && prev.valeur > 0 && Math.abs(o.valeur / prev.valeur - 1) > SEUIL_ABERRATION) {
        anomalies.push(s.indice + ' ' + o.key + ' : écart aberrant ' + o.valeur + ' vs ' + prev.valeur + ' (' + prev.key + ') — non écrit');
        prev = o; continue;
      }
      // Écriture si nouveau ou corrigé
      const ancien = existant[o.key];
      if (ancien === undefined || Math.abs(ancien - o.valeur) > 0.0001) {
        const row = { id: s.indice + '_' + o.key, indice: s.indice, periode: o.key, valeur: o.valeur, verifie: true, source: 'INSEE BDM ' + s.idBank, date_publication: o.dateJo };
        if (DRY_RUN) {
          console.log('  [écrirait] ' + s.indice + ' ' + o.key + ' = ' + o.valeur + (ancien === undefined ? ' (NOUVEAU)' : ' (corrige ' + ancien + ')'));
          nbEcrits++;
        } else {
          const w = await supabaseUpsert(row);
          if (w.status >= 200 && w.status < 300) { console.log('  [écrit] ' + s.indice + ' ' + o.key + ' = ' + o.valeur + (ancien === undefined ? ' (nouveau)' : ' (corrige ' + ancien + ')')); nbEcrits++; }
          else { anomalies.push(s.indice + ' ' + o.key + ' : écriture Supabase HTTP ' + w.status + ' ' + w.body); }
        }
      } else {
        nbInchanges++;
      }
      prev = o;
    }
    const dernier = obs[obs.length - 1];
    console.log('· ' + s.indice + ' : dernier INSEE = ' + dernier.key + ' (' + dernier.valeur + ', ' + dernier.qual + ')');
  }

  console.log('\n=== Bilan : ' + nbEcrits + ' écrit(s), ' + nbInchanges + ' inchangé(s), ' + anomalies.length + ' anomalie(s) ===');
  if (anomalies.length) {
    console.error('\n⚠ ANOMALIES (non écrites, à vérifier) :');
    anomalies.forEach(a => console.error('  - ' + a));
    process.exit(1); // fait échouer le job GitHub → notification e-mail
  }
}

main().catch(e => { console.error('Erreur fatale : ' + (e && e.stack || e)); process.exit(1); });
