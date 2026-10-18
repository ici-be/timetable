/**
 * Gestion du stockage local (localStorage uniquement, zéro serveur)
 * et utilitaires de dates / semaines pleines.
 */

import {
  STORAGE_KEY,
  getDefaultDateRange,
  formatDateISO,
  DEFAULT_MEMBERS,
  DEFAULT_DAY_TYPES,
  DEFAULT_RULES
} from './defaults.js';
import { normalizeRule } from './rules-schema.js';

/**
 * Charge l'état complet depuis le localStorage du navigateur,
 * ou initialise avec les valeurs par défaut.
 */
export function loadAppState() {
  const defaultRange = getDefaultDateRange();
  const baseState = {
    startDate: defaultRange.startDate,
    endDate: defaultRange.endDate,
    snapFullWeeks: true,
    members: structuredClone(DEFAULT_MEMBERS),
    dayTypes: structuredClone(DEFAULT_DAY_TYPES),
    rules: structuredClone(DEFAULT_RULES),
    // Clé: `${dateIso}__${memberId}` -> { requiredType: string|null, forbiddenTypes: string[], note?: string }
    desiderata: {},
    proposals: [],
    currentProposalIndex: -1
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSampleDesiderata(baseState);
    const parsed = JSON.parse(raw);

    return {
      startDate: parsed.startDate || baseState.startDate,
      endDate: parsed.endDate || baseState.endDate,
      snapFullWeeks: parsed.snapFullWeeks !== undefined ? Boolean(parsed.snapFullWeeks) : true,
      members: Array.isArray(parsed.members) && parsed.members.length > 0 ? parsed.members : baseState.members,
      dayTypes: Array.isArray(parsed.dayTypes) && parsed.dayTypes.length > 0 ? parsed.dayTypes : baseState.dayTypes,
      rules: Array.isArray(parsed.rules) ? parsed.rules.map((r, i) => normalizeRule(r, i)) : baseState.rules,
      desiderata: parsed.desiderata && typeof parsed.desiderata === 'object' ? parsed.desiderata : {},
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      currentProposalIndex: typeof parsed.currentProposalIndex === 'number' ? parsed.currentProposalIndex : -1
    };
  } catch (err) {
    console.warn('Erreur de lecture localStorage, utilisation de la configuration par défaut :', err);
    return createSampleDesiderata(baseState);
  }
}

/**
 * Ajoute 3 désidératas d'exemple sur la première semaine lors de la toute première visite
 * (illustrant les cas cités : Congé pour Martine, Télétravail pour Louis, Pas de TT+Perm pour André).
 */
function createSampleDesiderata(state) {
  const dates = getDatesInRange(state.startDate, state.endDate);
  if (dates.length >= 5) {
    // Mardi de la 1re semaine : Congé pour Martine
    state.desiderata[`${dates[1]}__m_martine`] = {
      requiredType: 'CONGE',
      forbiddenTypes: []
    };
    // Mercredi de la 1re semaine : Pas de TT+Perm pour André
    state.desiderata[`${dates[2]}__m_andre`] = {
      requiredType: null,
      forbiddenTypes: ['TT_PERM']
    };
    // Vendredi de la 1re semaine : Télétravail pour Louis
    state.desiderata[`${dates[4]}__m_louis`] = {
      requiredType: 'TT',
      forbiddenTypes: []
    };
  }
  return state;
}

/**
 * Sauvegarde l'état dans le localStorage du navigateur.
 */
export function saveAppState(state) {
  try {
    const toSave = {
      startDate: state.startDate,
      endDate: state.endDate,
      snapFullWeeks: state.snapFullWeeks,
      members: state.members,
      dayTypes: state.dayTypes,
      rules: state.rules,
      desiderata: state.desiderata,
      proposals: (state.proposals || []).slice(-10), // Garder les 10 dernières propositions max
      currentProposalIndex: state.currentProposalIndex
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (err) {
    console.error('Impossible de sauvegarder dans localStorage :', err);
  }
}

/**
 * Réinitialise les données aux valeurs d'usine.
 */
export function resetAppState() {
  localStorage.removeItem(STORAGE_KEY);
  return loadAppState();
}

/**
 * Ajuste une plage de dates pour couvrir des semaines pleines (du Lundi au Dimanche).
 */
export function alignToFullWeeks(startIso, endIso) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);

  const start = new Date(sy, sm - 1, sd, 12, 0, 0);
  let end = new Date(ey, em - 1, ed, 12, 0, 0);
  if (end < start) {
    end = new Date(start);
    end.setDate(start.getDate() + 20);
  }

  // Ramener start au Lundi de sa semaine
  const startDow = start.getDay(); // 0=Dim, 1=Lun..6=Sam
  const diffToMonday = startDow === 0 ? -6 : 1 - startDow;
  start.setDate(start.getDate() + diffToMonday);

  // Pousser end au Dimanche de sa semaine
  const endDow = end.getDay();
  const diffToSunday = endDow === 0 ? 0 : 7 - endDow;
  end.setDate(end.getDate() + diffToSunday);

  return {
    startDate: formatDateISO(start),
    endDate: formatDateISO(end)
  };
}

/**
 * Retourne la liste ordonnée des dates ISO entre startIso et endIso inclus.
 */
export function getDatesInRange(startIso, endIso, maxDays = 120) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd, 12, 0, 0);
  const end = new Date(ey, em - 1, ed, 12, 0, 0);

  const dates = [];
  let count = 0;
  while (cur <= end && count < maxDays) {
    dates.push(formatDateISO(cur));
    cur.setDate(cur.getDate() + 1);
    count++;
  }
  return dates;
}

/**
 * Découpe la plage entre startIso et endIso en lignes de semaines (Lundi -> Dimanche, 7 colonnes).
 * Chaque cellule hors plage éventuelle est marquée `inRange: false` si snapFullWeeks est désactivé.
 */
export function buildWeeksRows(startIso, endIso) {
  const aligned = alignToFullWeeks(startIso, endIso);
  const allWeekDates = getDatesInRange(aligned.startDate, aligned.endDate, 182);

  const weeks = [];
  for (let i = 0; i < allWeekDates.length; i += 7) {
    const slice = allWeekDates.slice(i, i + 7);
    if (slice.length === 0) continue;
    const days = slice.map(iso => {
      const [y, m, d] = iso.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d, 12, 0, 0);
      const dow = dateObj.getDay();
      return {
        iso,
        dateObj,
        dayNum: d,
        monthNum: m,
        year: y,
        dow,
        isWeekend: dow === 0 || dow === 6,
        inRange: iso >= startIso && iso <= endIso
      };
    });
    weeks.push({
      weekIndex: weeks.length,
      startIso: days[0].iso,
      endIso: days[days.length - 1].iso,
      weekNumber: getISOWeekNumber(days[0].dateObj),
      days
    });
  }
  return weeks;
}

/**
 * Calcule le numéro de semaine ISO-8601.
 */
export function getISOWeekNumber(dateObj) {
  const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
