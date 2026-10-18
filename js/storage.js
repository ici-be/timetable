/**
 * Gestion du stockage local (localStorage uniquement, zéro serveur)
 * et utilitaires de dates / semaines pleines.
 */

import {
  STORAGE_KEY,
  DEFAULT_WEEKS_COUNT,
  getDefaultDateRange,
  formatDateISO,
  DEFAULT_MEMBERS,
  DEFAULT_DAY_TYPES,
  DEFAULT_RULES
} from './defaults.js';
import { normalizeRule } from './rules-schema.js';

/**
 * Calcule une plage de N semaines à partir d'une date de début.
 */
export function computeRangeForWeeks(startIso, weeksCount = DEFAULT_WEEKS_COUNT, snapFullWeeks = true) {
  const validWeeks = Math.max(1, Math.min(26, Number(weeksCount) || DEFAULT_WEEKS_COUNT));
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd, 12, 0, 0);

  if (snapFullWeeks) {
    const startDow = start.getDay();
    const diffToMonday = startDow === 0 ? -6 : 1 - startDow;
    start.setDate(start.getDate() + diffToMonday);
  }

  const end = new Date(start);
  end.setDate(start.getDate() + validWeeks * 7 - 1);

  return {
    startDate: formatDateISO(start),
    endDate: formatDateISO(end),
    weeksCount: validWeeks
  };
}

/**
 * Charge l'état complet depuis le localStorage du navigateur,
 * ou initialise avec les valeurs par défaut.
 */
export function loadAppState() {
  const defaultRange = getDefaultDateRange(DEFAULT_WEEKS_COUNT);
  const baseState = {
    startDate: defaultRange.startDate,
    endDate: defaultRange.endDate,
    weeksCount: DEFAULT_WEEKS_COUNT,
    snapFullWeeks: true,
    collapseWeekends: true,
    calendarSort: 'type', // 'type' (par défaut) | 'member'
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

    const snapFullWeeks = parsed.snapFullWeeks !== undefined ? Boolean(parsed.snapFullWeeks) : true;
    const collapseWeekends = parsed.collapseWeekends !== undefined ? Boolean(parsed.collapseWeekends) : true;
    let startDate = parsed.startDate || baseState.startDate;
    let endDate = parsed.endDate || baseState.endDate;
    let weeksCount = typeof parsed.weeksCount === 'number' && parsed.weeksCount >= 1
      ? parsed.weeksCount
      : DEFAULT_WEEKS_COUNT;

    // Migration douce : si l'état précédent n'avait pas weeksCount enregistré, appliquer 2 semaines par défaut
    if (parsed.weeksCount === undefined) {
      const migratedRange = computeRangeForWeeks(startDate, DEFAULT_WEEKS_COUNT, snapFullWeeks);
      startDate = migratedRange.startDate;
      endDate = migratedRange.endDate;
      weeksCount = DEFAULT_WEEKS_COUNT;
    }

    return {
      startDate,
      endDate,
      weeksCount,
      snapFullWeeks,
      collapseWeekends,
      calendarSort: parsed.calendarSort === 'member' ? 'member' : 'type',
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
 * Initialise les désidératas par défaut (vierge pour permettre de tester librement
 * la répartition équitable des 10 membres, ou d'ajouter des congés / maladies à la volée).
 */
function createSampleDesiderata(state) {
  state.desiderata = {};
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
      weeksCount: state.weeksCount,
      snapFullWeeks: state.snapFullWeeks,
      collapseWeekends: state.collapseWeekends !== undefined ? Boolean(state.collapseWeekends) : true,
      calendarSort: state.calendarSort || 'type',
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
    end.setDate(start.getDate() + DEFAULT_WEEKS_COUNT * 7 - 1);
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
