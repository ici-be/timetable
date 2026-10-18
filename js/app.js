/**
 * Contrôleur principal de l'application Horaires d'Équipe (ici.be/timetable)
 */

import {
  DEFAULT_WEEKS_COUNT,
  getDefaultDateRange,
  formatDateISO
} from './defaults.js';
import {
  RULE_KINDS,
  DAY_NAMES_FR,
  normalizeRule,
  parseRulesFromJSON,
  summarizeRuleParams,
  generateLLMPrompt
} from './rules-schema.js';
import {
  buildDateMetadata,
  compileRules,
  evaluateSchedule,
  computeScheduleStats,
  generateSchedule,
  analyzeCellAlternatives,
  reoptimizeAroundCellChange
} from './solver.js';
import {
  loadAppState,
  saveAppState,
  resetAppState,
  computeRangeForWeeks,
  alignToFullWeeks,
  getDatesInRange,
  buildWeeksRows
} from './storage.js';

let state = loadAppState();
let activeModalCell = null; // { dateIso, memberId }

const MONTHS_SHORT_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const DOW_SHORT_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

/**
 * Génère une couleur de fond claire et de texte foncé à partir d'une couleur hexadécimale.
 */
function deriveBadgeColors(hex) {
  const clean = (hex || '#2563eb').replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 37;
  const g = parseInt(clean.substring(2, 4), 16) || 99;
  const b = parseInt(clean.substring(4, 6), 16) || 235;
  const bg = `rgba(${r}, ${g}, ${b}, 0.16)`;
  return { color: `#${clean}`, bgColor: bg, textColor: `#${clean}` };
}

function getEffectiveDateISOs() {
  if (state.snapFullWeeks) {
    const aligned = alignToFullWeeks(state.startDate, state.endDate);
    return getDatesInRange(aligned.startDate, aligned.endDate);
  }
  return getDatesInRange(state.startDate, state.endDate);
}

function getCurrentProposal() {
  if (
    state.currentProposalIndex >= 0 &&
    state.currentProposalIndex < state.proposals.length
  ) {
    return state.proposals[state.currentProposalIndex];
  }
  return null;
}

/**
 * Ré-évalue la proposition courante (après changement d'une règle ou d'une case).
 */
function refreshCurrentProposalEvaluation() {
  const prop = getCurrentProposal();
  if (!prop) return;
  const dateISOs = getEffectiveDateISOs();
  const activeMembers = state.members.filter(m => m.active !== false);
  const dateMeta = buildDateMetadata(dateISOs);
  const compiledRules = compileRules(state.rules, state.dayTypes, activeMembers, dateMeta);

  // S'assurer que chaque date a un objet dans grid
  for (const iso of dateISOs) {
    if (!prop.grid[iso]) prop.grid[iso] = {};
  }

  prop.evaluation = evaluateSchedule(
    prop.grid,
    dateMeta,
    activeMembers,
    state.dayTypes,
    state.desiderata,
    compiledRules
  );
  prop.stats = computeScheduleStats(prop.grid, dateMeta, activeMembers, state.dayTypes);
}

/**
 * Lance la génération d'une nouvelle proposition d'horaire.
 */
function runScheduleGenerator({ isAlternative = false } = {}) {
  const dateISOs = getEffectiveDateISOs();
  const currentProp = getCurrentProposal();
  const previousGrid = isAlternative && currentProp ? currentProp.grid : null;
  const seed = Date.now() + Math.floor(Math.random() * 100000);

  const solved = generateSchedule({
    dateISOs,
    members: state.members,
    dayTypes: state.dayTypes,
    rules: state.rules,
    desiderata: state.desiderata,
    seed,
    previousGrid,
    maxIterations: 2200
  });

  const proposalNumber = state.proposals.length + 1;
  const newProp = {
    id: `prop_${Date.now()}`,
    label: `Proposition #${proposalNumber}`,
    createdAt: new Date().toISOString(),
    grid: solved.grid,
    evaluation: solved.evaluation,
    stats: solved.stats
  };

  state.proposals.push(newProp);
  if (state.proposals.length > 10) {
    state.proposals.shift();
  }
  state.currentProposalIndex = state.proposals.length - 1;
  saveAppState(state);
  renderAll();
}

/**
 * Initialise tous les écouteurs d'événements et génère une proposition initiale si aucune n'existe.
 */
function init() {
  if (state.snapFullWeeks) {
    const aligned = alignToFullWeeks(state.startDate, state.endDate);
    state.startDate = aligned.startDate;
    state.endDate = aligned.endDate;
  }

  bindHeaderAndSettingsEvents();
  bindDrawerEvents();
  bindRuleBuilderForm();
  bindModalEvents();

  const prop = getCurrentProposal();
  const dateISOs = getEffectiveDateISOs();
  const hasAllDates = prop && dateISOs.every(iso => prop.grid && prop.grid[iso]);

  if (!prop || !hasAllDates) {
    runScheduleGenerator({ isAlternative: false });
  } else {
    refreshCurrentProposalEvaluation();
    renderAll();
  }
}

function bindHeaderAndSettingsEvents() {
  const weeksSelect = document.getElementById('select-weeks-count');
  const startInput = document.getElementById('input-start-date');
  const endInput = document.getElementById('input-end-date');
  const snapCheckbox = document.getElementById('chk-snap-weeks');
  const sortSelect = document.getElementById('select-calendar-sort');

  weeksSelect.addEventListener('change', () => {
    const w = Number(weeksSelect.value);
    if (!w || w < 1) return;
    const range = computeRangeForWeeks(state.startDate, w, state.snapFullWeeks);
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    state.weeksCount = range.weeksCount;
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  });

  startInput.addEventListener('change', () => {
    if (!startInput.value) return;
    const targetWeeks = state.weeksCount || DEFAULT_WEEKS_COUNT;
    const range = computeRangeForWeeks(startInput.value, targetWeeks, state.snapFullWeeks);
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    state.weeksCount = range.weeksCount;
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  });

  endInput.addEventListener('change', () => {
    if (!endInput.value) return;
    state.endDate = endInput.value;
    if (state.endDate < state.startDate) {
      state.startDate = state.endDate;
    }
    if (state.snapFullWeeks) {
      const aligned = alignToFullWeeks(state.startDate, state.endDate);
      state.startDate = aligned.startDate;
      state.endDate = aligned.endDate;
    }
    const weeksRows = buildWeeksRows(state.startDate, state.endDate);
    state.weeksCount = Math.max(1, weeksRows.length);
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  });

  snapCheckbox.addEventListener('change', () => {
    state.snapFullWeeks = snapCheckbox.checked;
    if (state.snapFullWeeks) {
      const aligned = alignToFullWeeks(state.startDate, state.endDate);
      state.startDate = aligned.startDate;
      state.endDate = aligned.endDate;
    }
    saveAppState(state);
    renderAll();
  });

  document.getElementById('btn-prev-week').addEventListener('click', () => {
    shiftDateRangeDays(-7);
  });

  document.getElementById('btn-next-week').addEventListener('click', () => {
    shiftDateRangeDays(7);
  });

  document.getElementById('btn-default-period').addEventListener('click', () => {
    const def = getDefaultDateRange(state.weeksCount || DEFAULT_WEEKS_COUNT);
    state.startDate = def.startDate;
    state.endDate = def.endDate;
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  });

  document.getElementById('btn-generate').addEventListener('click', () => {
    state.proposals = [];
    state.currentProposalIndex = -1;
    runScheduleGenerator({ isAlternative: false });
  });

  document.getElementById('btn-alternative').addEventListener('click', () => {
    runScheduleGenerator({ isAlternative: true });
  });

  document.getElementById('btn-prev-prop').addEventListener('click', () => {
    if (state.currentProposalIndex > 0) {
      state.currentProposalIndex--;
      refreshCurrentProposalEvaluation();
      saveAppState(state);
      renderAll();
    }
  });

  document.getElementById('btn-next-prop').addEventListener('click', () => {
    if (state.currentProposalIndex < state.proposals.length - 1) {
      state.currentProposalIndex++;
      refreshCurrentProposalEvaluation();
      saveAppState(state);
      renderAll();
    }
  });

  // Sélecteur de tri dans les cases du calendrier (par type de journée par défaut, ou par personne)
  sortSelect.addEventListener('change', (e) => {
    state.calendarSort = e.target.value === 'member' ? 'member' : 'type';
    saveAppState(state);
    renderCalendar();
  });

  // Bouton pour replier / déplier les week-ends
  document.getElementById('btn-toggle-weekends').addEventListener('click', () => {
    state.collapseWeekends = !state.collapseWeekends;
    saveAppState(state);
    updateWeekendsCollapsedState();
  });

  // Sélecteur de pinceau / mode d'interaction
  document.getElementById('select-interaction-mode').addEventListener('change', (e) => {
    const val = e.target.value;
    const hint = document.getElementById('brush-hint');
    if (hint) {
      if (val === 'inspect') {
        hint.textContent = 'Cliquez sur un membre dans un jour du calendrier pour définir un désidérata ou modifier son horaire.';
      } else if (val === 'clear_des') {
        hint.textContent = 'Mode gomme : cliquez sur un membre dans le calendrier pour effacer son désidérata.';
      } else if (val.startsWith('req:')) {
        const dt = state.dayTypes.find(d => d.id === val.slice(4));
        hint.textContent = `Pinceau actif : cliquez sur un membre pour demander/fixer "${dt ? dt.label : val.slice(4)}".`;
      } else if (val.startsWith('forbid:')) {
        const dt = state.dayTypes.find(d => d.id === val.slice(7));
        hint.textContent = `Pinceau actif : cliquez sur un membre pour interdire "Pas de ${dt ? dt.label : val.slice(7)}".`;
      }
    }
  });

  // Export CSV
  document.getElementById('btn-export-csv').addEventListener('click', exportCurrentScheduleCSV);

  // Print
  document.getElementById('btn-print').addEventListener('click', () => window.print());

  // Sauvegarde JSON
  document.getElementById('btn-backup-json').addEventListener('click', openBackupModal);

  // Réinitialisation
  document.getElementById('btn-reset-all').addEventListener('click', () => {
    if (confirm('Réinitialiser les membres, types de journées, règles et désidératas aux valeurs de démonstration ?')) {
      state = resetAppState();
      runScheduleGenerator({ isAlternative: false });
    }
  });
}

function shiftDateRangeDays(deltaDays) {
  const [sy, sm, sd] = state.startDate.split('-').map(Number);
  const [ey, em, ed] = state.endDate.split('-').map(Number);
  const s = new Date(sy, sm - 1, sd, 12, 0, 0);
  const e = new Date(ey, em - 1, ed, 12, 0, 0);
  s.setDate(s.getDate() + deltaDays);
  e.setDate(e.getDate() + deltaDays);
  state.startDate = formatDateISO(s);
  state.endDate = formatDateISO(e);
  saveAppState(state);
  runScheduleGenerator({ isAlternative: false });
}

function bindDrawerEvents() {
  const tabBtns = document.querySelectorAll('.btn-tab[data-panel]');
  const panels = document.querySelectorAll('.drawer-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-panel');
      const targetPanel = document.getElementById(targetId);
      const isHidden = targetPanel.hasAttribute('hidden');

      panels.forEach(p => p.setAttribute('hidden', ''));
      tabBtns.forEach(b => b.classList.remove('active'));

      if (isHidden) {
        targetPanel.removeAttribute('hidden');
        btn.classList.add('active');
        if (targetId === 'panel-llm') {
          refreshLLMPanel();
        }
      }
    });
  });

  document.querySelectorAll('[data-close-drawer]').forEach(closeBtn => {
    closeBtn.addEventListener('click', () => {
      panels.forEach(p => p.setAttribute('hidden', ''));
      tabBtns.forEach(b => b.classList.remove('active'));
    });
  });

  // Ajout d'un membre
  document.getElementById('form-add-member').addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('new-member-name');
    const roleInput = document.getElementById('new-member-role');
    const colorInput = document.getElementById('new-member-color');
    const name = nameInput.value.trim();
    if (!name) return;

    state.members.push({
      id: `m_${Date.now()}`,
      name,
      role: roleInput.value.trim() || 'Équipe',
      color: colorInput.value || '#2563eb',
      active: true
    });
    nameInput.value = '';
    roleInput.value = '';
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  });

  // Ajout d'un type de journée
  document.getElementById('form-add-type').addEventListener('submit', (e) => {
    e.preventDefault();
    const idRaw = document.getElementById('new-type-id').value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const label = document.getElementById('new-type-label').value.trim();
    const shortLabel = document.getElementById('new-type-short').value.trim();
    const dayScope = document.getElementById('new-type-scope').value;
    const tagsRaw = document.getElementById('new-type-tags').value;
    const color = document.getElementById('new-type-color').value;
    const autoAssign = document.getElementById('new-type-auto').checked;

    if (!idRaw || !label || !shortLabel) return;
    if (state.dayTypes.some(dt => dt.id === idRaw)) {
      alert(`Le code "${idRaw}" existe déjà.`);
      return;
    }

    const derived = deriveBadgeColors(color);
    const tags = tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

    state.dayTypes.push({
      id: idRaw,
      label,
      shortLabel,
      color: derived.color,
      bgColor: derived.bgColor,
      textColor: derived.textColor,
      dayScope,
      autoAssign,
      isWorkingDay: !tags.includes('repos') && !tags.includes('absence') && !tags.includes('conge'),
      isDefaultRest: false,
      tags
    });

    document.getElementById('new-type-id').value = '';
    document.getElementById('new-type-label').value = '';
    document.getElementById('new-type-short').value = '';
    document.getElementById('new-type-tags').value = '';

    saveAppState(state);
    renderRuleDynamicParams();
    runScheduleGenerator({ isAlternative: false });
  });

  // Boutons du panneau LLM
  document.getElementById('btn-copy-prompt').addEventListener('click', () => {
    const promptArea = document.getElementById('llm-prompt-output');
    navigator.clipboard.writeText(promptArea.value);
    const fb = document.getElementById('copy-prompt-feedback');
    fb.removeAttribute('hidden');
    setTimeout(() => fb.setAttribute('hidden', ''), 2500);
  });

  document.getElementById('btn-import-rules-replace').addEventListener('click', () => {
    importRulesFromLLMTextarea(false);
  });

  document.getElementById('btn-import-rules-append').addEventListener('click', () => {
    importRulesFromLLMTextarea(true);
  });

  // Effacer tous les désidératas
  document.getElementById('btn-clear-desiderata').addEventListener('click', () => {
    if (confirm('Effacer tous les désidératas enregistrés ?')) {
      state.desiderata = {};
      saveAppState(state);
      runScheduleGenerator({ isAlternative: false });
    }
  });
}

function refreshLLMPanel() {
  const promptOutput = document.getElementById('llm-prompt-output');
  const jsonInput = document.getElementById('llm-json-input');
  promptOutput.value = generateLLMPrompt(state.dayTypes, state.members, state.rules);
  jsonInput.value = JSON.stringify(state.rules, null, 2);
  document.getElementById('llm-json-error').setAttribute('hidden', '');
}

function importRulesFromLLMTextarea(append = false) {
  const jsonInput = document.getElementById('llm-json-input');
  const errorBox = document.getElementById('llm-json-error');
  errorBox.setAttribute('hidden', '');

  try {
    const importedRules = parseRulesFromJSON(jsonInput.value);
    if (importedRules.length === 0) {
      throw new Error('Aucune règle trouvée dans le JSON fourni.');
    }
    if (append) {
      state.rules.push(...importedRules);
    } else {
      state.rules = importedRules;
    }
    saveAppState(state);
    refreshLLMPanel();
    runScheduleGenerator({ isAlternative: false });
  } catch (err) {
    errorBox.textContent = `Erreur JSON : ${err.message}`;
    errorBox.removeAttribute('hidden');
  }
}

/**
 * Constructeur visuel de règles (s'adapte dynamiquement aux 8 catégories génériques).
 */
function bindRuleBuilderForm() {
  const kindSelect = document.getElementById('rule-kind');
  kindSelect.innerHTML = Object.entries(RULE_KINDS)
    .map(([k, info]) => `<option value="${k}">${info.label}</option>`)
    .join('');

  kindSelect.addEventListener('change', renderRuleDynamicParams);
  renderRuleDynamicParams();

  document.getElementById('form-add-rule').addEventListener('submit', (e) => {
    e.preventDefault();
    const kind = kindSelect.value;
    const name = document.getElementById('rule-name').value.trim() || RULE_KINDS[kind].label;
    const severity = document.getElementById('rule-severity').value;

    const selectedTypes = Array.from(document.querySelectorAll('input[name="rb-target-type"]:checked')).map(el => el.value);
    const targetTypes = selectedTypes.length > 0 ? selectedTypes : ['BUREAU'];

    const params = {};
    if (kind === 'daily_headcount') {
      params.dayFilter = document.getElementById('rb-day-filter')?.value || 'weekday';
      params.targetTypes = targetTypes;
      const minVal = document.getElementById('rb-min')?.value;
      const maxVal = document.getElementById('rb-max')?.value;
      params.min = minVal !== '' ? Number(minVal) : null;
      params.max = maxVal !== '' ? Number(maxVal) : null;
    } else if (kind === 'member_period_count') {
      params.period = document.getElementById('rb-period')?.value || 'week';
      params.dayFilter = 'all';
      params.targetTypes = targetTypes;
      params.targetMembers = 'all';
      const minVal = document.getElementById('rb-min')?.value;
      const maxVal = document.getElementById('rb-max')?.value;
      params.min = minVal !== '' ? Number(minVal) : null;
      params.max = maxVal !== '' ? Number(maxVal) : null;
    } else if (kind === 'sequence_transition') {
      const trigType = document.getElementById('rb-trigger-type')?.value || 'CONGE';
      params.triggerTypes = [trigType];
      params.minTriggerStreak = Math.max(1, Number(document.getElementById('rb-min-streak')?.value) || 1);
      params.direction = document.getElementById('rb-direction')?.value === 'before' ? 'before' : 'after';
      const offset = Math.abs(Number(document.getElementById('rb-offset')?.value) || 1);
      params.offsetDays = params.direction === 'before' ? -offset : offset;
      params.skipWeekends = document.getElementById('rb-skip-weekends')?.checked ?? true;
      params.mode = document.getElementById('rb-mode')?.value || 'forbid';
      params.targetTypes = targetTypes;
      params.targetMembers = 'all';
    } else if (kind === 'max_consecutive_days') {
      params.targetTypes = targetTypes;
      params.maxConsecutive = Number(document.getElementById('rb-max-consec')?.value) || 2;
      params.skipWeekends = false;
      params.targetMembers = 'all';
    } else if (kind === 'weekend_pair_consistency') {
      params.targetTypes = targetTypes;
    } else if (kind === 'member_day_restriction') {
      const dow = Number(document.getElementById('rb-dow')?.value ?? 3);
      params.daysOfWeek = [dow];
      params.mode = document.getElementById('rb-mode')?.value || 'forbid';
      params.targetTypes = targetTypes;
      const memberSel = document.getElementById('rb-member')?.value || 'all';
      params.targetMembers = memberSel === 'all' ? 'all' : [memberSel];
    } else if (kind === 'member_compatibility') {
      params.dayFilter = document.getElementById('rb-day-filter')?.value || 'weekday';
      params.mode = document.getElementById('rb-compat-mode')?.value || 'not_together';
      params.targetTypes = targetTypes;
      const m1 = document.getElementById('rb-member-1')?.value;
      const m2 = document.getElementById('rb-member-2')?.value;
      params.targetMembers = [m1, m2].filter(Boolean);
    } else if (kind === 'fairness_balance') {
      params.targetTypes = targetTypes;
      params.targetMembers = 'all';
    } else if (kind === 'daily_balance') {
      params.dayFilter = document.getElementById('rb-day-filter')?.value || 'weekday';
      params.groupATypes = Array.from(document.querySelectorAll('input[name="rb-group-a"]:checked')).map(el => el.value);
      params.groupBTypes = Array.from(document.querySelectorAll('input[name="rb-group-b"]:checked')).map(el => el.value);
    } else if (kind === 'max_consecutive_weekends') {
      params.maxConsecutiveWeekends = Number(document.getElementById('rb-max-weekends')?.value) || 1;
      params.targetTypes = targetTypes;
      const memberSel = document.getElementById('rb-member')?.value || 'all';
      params.targetMembers = memberSel === 'all' ? 'all' : [memberSel];
      params.mode = 'forbid_service';
    }

    const newRule = normalizeRule({
      id: `r_${Date.now()}`,
      name,
      enabled: true,
      severity,
      weight: severity === 'hard' ? 100 : 50,
      kind,
      params
    });

    state.rules.push(newRule);
    document.getElementById('rule-name').value = '';
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  });
}

function renderRuleDynamicParams() {
  const container = document.getElementById('rule-dynamic-params');
  const kind = document.getElementById('rule-kind')?.value || 'daily_headcount';

  const typeCheckboxes = state.dayTypes.map((dt, i) => `
    <label class="checkbox-inline">
      <input type="checkbox" name="rb-target-type" value="${dt.id}" ${i === 0 ? 'checked' : ''} />
      <span>${dt.shortLabel}</span>
    </label>
  `).join('');

  const typeOptions = state.dayTypes.map(dt => `<option value="${dt.id}">${dt.label} (${dt.id})</option>`).join('');
  const memberOptions = `<option value="all">Tous les membres</option>` +
    state.members.map(m => `<option value="${m.id}">${m.name}</option>`).join('');

  let html = '';

  if (kind === 'daily_headcount') {
    html = `
      <div class="form-field">
        <label>Jours concernés</label>
        <select id="rb-day-filter">
          <option value="weekday">Jours de semaine (Lun–Ven)</option>
          <option value="weekend">Weekend (Sam–Dim)</option>
          <option value="all">Tous les jours</option>
        </select>
      </div>
      <div class="form-field">
        <label>Min. personnes</label>
        <input type="number" id="rb-min" min="0" max="50" value="3" style="width:80px;" />
      </div>
      <div class="form-field">
        <label>Max. personnes (optionnel)</label>
        <input type="number" id="rb-max" min="0" max="50" placeholder="Illimité" style="width:90px;" />
      </div>
      <div class="form-field">
        <label>Types de journées comptabilisés</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'member_period_count') {
    html = `
      <div class="form-field">
        <label>Période</label>
        <select id="rb-period">
          <option value="week">Par semaine</option>
          <option value="horizon">Sur toute la période</option>
        </select>
      </div>
      <div class="form-field">
        <label>Min. jours</label>
        <input type="number" id="rb-min" min="0" max="31" value="0" style="width:80px;" />
      </div>
      <div class="form-field">
        <label>Max. jours</label>
        <input type="number" id="rb-max" min="0" max="31" value="2" style="width:80px;" />
      </div>
      <div class="form-field">
        <label>Types de journées ciblés</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'sequence_transition') {
    html = `
      <div class="form-field">
        <label>Séquence déclencheuse</label>
        <select id="rb-trigger-type">${typeOptions}</select>
      </div>
      <div class="form-field">
        <label>Longueur min. (jours consécutifs)</label>
        <input type="number" id="rb-min-streak" min="1" max="30" value="1" style="width:70px;" />
      </div>
      <div class="form-field">
        <label>Position</label>
        <select id="rb-direction">
          <option value="after">Après la séquence</option>
          <option value="before">Avant la séquence</option>
        </select>
      </div>
      <div class="form-field">
        <label>Décalage (N jours)</label>
        <input type="number" id="rb-offset" min="1" max="7" value="1" style="width:70px;" />
      </div>
      <div class="form-field">
        <label class="checkbox-inline">
          <input type="checkbox" id="rb-skip-weekends" checked />
          <span>Ignorer les weekends (jours ouvrés)</span>
        </label>
      </div>
      <div class="form-field">
        <label>Action sur le jour visé</label>
        <select id="rb-mode">
          <option value="forbid">Interdire les types cochés</option>
          <option value="require">Imposer l'un des types cochés</option>
        </select>
      </div>
      <div class="form-field">
        <label>Types ciblés à J+N</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'max_consecutive_days') {
    html = `
      <div class="form-field">
        <label>Max. jours consécutifs</label>
        <input type="number" id="rb-max-consec" min="1" max="14" value="2" style="width:90px;" />
      </div>
      <div class="form-field">
        <label>Types de journées ciblés</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'weekend_pair_consistency') {
    html = `
      <div class="form-field">
        <label>Types de journées devant être assurés par la même personne Samedi + Dimanche</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'member_day_restriction') {
    html = `
      <div class="form-field">
        <label>Membre concerné</label>
        <select id="rb-member">${memberOptions}</select>
      </div>
      <div class="form-field">
        <label>Jour de la semaine</label>
        <select id="rb-dow">
          <option value="1">Lundi</option>
          <option value="2">Mardi</option>
          <option value="3" selected>Mercredi</option>
          <option value="4">Jeudi</option>
          <option value="5">Vendredi</option>
          <option value="6">Samedi</option>
          <option value="0">Dimanche</option>
        </select>
      </div>
      <div class="form-field">
        <label>Règle</label>
        <select id="rb-mode">
          <option value="forbid">Interdire</option>
          <option value="require">Imposer</option>
        </select>
      </div>
      <div class="form-field">
        <label>Types ciblés</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'member_compatibility') {
    const mOnlyOptions = state.members.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    html = `
      <div class="form-field">
        <label>Membre 1</label>
        <select id="rb-member-1">${mOnlyOptions}</select>
      </div>
      <div class="form-field">
        <label>Membre 2</label>
        <select id="rb-member-2">${mOnlyOptions}</select>
      </div>
      <div class="form-field">
        <label>Condition</label>
        <select id="rb-compat-mode">
          <option value="not_together">Pas en même temps sur ces types</option>
          <option value="together">Ensemble sur ces types</option>
          <option value="at_least_one">Au moins l'un des deux sur ces types</option>
        </select>
      </div>
      <div class="form-field">
        <label>Jours</label>
        <select id="rb-day-filter">
          <option value="weekday">Semaine</option>
          <option value="weekend">Weekend</option>
          <option value="all">Tous</option>
        </select>
      </div>
      <div class="form-field">
        <label>Types ciblés</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'fairness_balance') {
    html = `
      <div class="form-field">
        <label>Types de journées à répartir équitablement entre les membres</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  } else if (kind === 'daily_balance') {
    const groupChecks = (name, defaults) => state.dayTypes.map(dt => `
      <label class="checkbox-inline">
        <input type="checkbox" name="${name}" value="${dt.id}" ${defaults.includes(dt.id) ? 'checked' : ''} />
        <span>${dt.shortLabel}</span>
      </label>
    `).join('');
    html = `
      <div class="form-field">
        <label>Jours concernés</label>
        <select id="rb-day-filter">
          <option value="weekday">Jours de semaine (Lun–Ven)</option>
          <option value="weekend">Weekend (Sam–Dim)</option>
          <option value="all">Tous les jours</option>
        </select>
      </div>
      <div class="form-field">
        <label>Groupe A (ex : présentiel)</label>
        <div class="chips-group">${groupChecks('rb-group-a', ['BUREAU', 'BUREAU_MATIN', 'BUREAU_MIDI', 'BUREAU_SOIR'])}</div>
      </div>
      <div class="form-field">
        <label>Groupe B (ex : télétravail)</label>
        <div class="chips-group">${groupChecks('rb-group-b', ['TT'])}</div>
      </div>
    `;
  } else if (kind === 'max_consecutive_weekends') {
    html = `
      <div class="form-field">
        <label>Nombre maximum de weekends consécutifs de service</label>
        <input type="number" id="rb-max-weekends" min="1" max="10" value="1" style="width:70px;" />
      </div>
      <div class="form-field">
        <label>Membres concernés</label>
        <select id="rb-member">${memberOptions}</select>
      </div>
      <div class="form-field">
        <label>Types considérés comme repos (non-service)</label>
        <div class="chips-group">${typeCheckboxes}</div>
      </div>
    `;
  }

  container.innerHTML = html;
}

/**
 * Rendu global de l'interface.
 */
function renderAll() {
  renderTopBar();
  renderInteractionBrushOptions();
  renderMembersDrawer();
  renderTypesDrawer();
  renderRulesDrawer();
  renderDesiderataDrawer();
  renderCalendar();
  renderSummaryAndStatus();
}

function renderTopBar() {
  document.getElementById('input-start-date').value = state.startDate;
  document.getElementById('input-end-date').value = state.endDate;
  document.getElementById('chk-snap-weeks').checked = Boolean(state.snapFullWeeks);

  const weeksSelect = document.getElementById('select-weeks-count');
  const displayedWeeks = buildWeeksRows(state.startDate, state.endDate).length;
  const weeksStr = String(displayedWeeks);
  const customOpt = weeksSelect.querySelector('option[value="custom"]');
  if (Array.from(weeksSelect.options).some(o => o.value === weeksStr)) {
    weeksSelect.value = weeksStr;
    if (customOpt) customOpt.hidden = true;
  } else if (customOpt) {
    customOpt.hidden = false;
    customOpt.textContent = `${displayedWeeks} sem. (libre)`;
    weeksSelect.value = 'custom';
  }

  const sortSelect = document.getElementById('select-calendar-sort');
  if (sortSelect) {
    sortSelect.value = state.calendarSort === 'member' ? 'member' : 'type';
  }

  const activeMembersCount = state.members.filter(m => m.active !== false).length;
  const activeRulesCount = state.rules.filter(r => r.enabled !== false).length;
  const activeDesCount = Object.values(state.desiderata || {}).filter(
    d => d && (d.requiredType || (Array.isArray(d.forbiddenTypes) && d.forbiddenTypes.length > 0))
  ).length;

  document.getElementById('count-members').textContent = activeMembersCount;
  document.getElementById('count-types').textContent = state.dayTypes.length;
  document.getElementById('count-rules').textContent = activeRulesCount;
  document.getElementById('count-desiderata').textContent = activeDesCount;

  const switcher = document.getElementById('proposal-switcher');
  if (state.proposals.length > 0) {
    switcher.removeAttribute('hidden');
    document.getElementById('proposal-label').textContent =
      `Proposition #${state.currentProposalIndex + 1} / ${state.proposals.length}`;
    document.getElementById('btn-prev-prop').disabled = state.currentProposalIndex <= 0;
    document.getElementById('btn-next-prop').disabled = state.currentProposalIndex >= state.proposals.length - 1;
  } else {
    switcher.setAttribute('hidden', '');
  }
}

function renderInteractionBrushOptions() {
  const select = document.getElementById('select-interaction-mode');
  const currentVal = select.value || 'inspect';

  const reqOptions = state.dayTypes
    .map(dt => `<option value="req:${dt.id}">Pinceau Désidérata : Demander « ${dt.label} »</option>`)
    .join('');

  const forbidOptions = state.dayTypes
    .map(dt => `<option value="forbid:${dt.id}">Pinceau Désidérata : Pas de « ${dt.label} »</option>`)
    .join('');

  select.innerHTML = `
    <option value="inspect">Menu complet (Désidérata + Changer l'affectation)</option>
    <optgroup label="Saisie rapide : Demander / Fixer un type">
      ${reqOptions}
    </optgroup>
    <optgroup label="Saisie rapide : Interdire un type (« Pas de... »)">
      ${forbidOptions}
    </optgroup>
    <optgroup label="Effacer">
      <option value="clear_des">Gomme : Effacer le désidérata cliqué</option>
    </optgroup>
  `;

  if (Array.from(select.options).some(o => o.value === currentVal)) {
    select.value = currentVal;
  }
}

function renderMembersDrawer() {
  const container = document.getElementById('members-list');
  container.innerHTML = state.members.map(m => `
    <div class="item-card">
      <div class="item-card-info">
        <span class="color-dot" style="background:${m.color || '#2563eb'}"></span>
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(m.role || 'Équipe')}</div>
        </div>
      </div>
      <div class="btn-row">
        <label class="checkbox-inline" title="Actif dans la planification">
          <input type="checkbox" data-toggle-member="${m.id}" ${m.active !== false ? 'checked' : ''} />
          <span>Actif</span>
        </label>
        <button type="button" class="btn btn-danger-ghost btn-xs" data-delete-member="${m.id}" title="Supprimer">✕</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-toggle-member]').forEach(cb => {
    cb.addEventListener('change', () => {
      const m = state.members.find(x => x.id === cb.getAttribute('data-toggle-member'));
      if (m) {
        m.active = cb.checked;
        saveAppState(state);
        runScheduleGenerator({ isAlternative: false });
      }
    });
  });

  container.querySelectorAll('[data-delete-member]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-delete-member');
      if (state.members.length <= 1) {
        alert('Il doit rester au moins un membre dans l\'équipe.');
        return;
      }
      state.members = state.members.filter(x => x.id !== id);
      saveAppState(state);
      runScheduleGenerator({ isAlternative: false });
    });
  });
}

function renderTypesDrawer() {
  const container = document.getElementById('types-list');
  const scopeLabels = { weekday: 'Semaine', weekend: 'Weekend', both: 'Tous les jours' };

  container.innerHTML = state.dayTypes.map(dt => `
    <div class="item-card">
      <div class="item-card-info">
        <span class="type-badge" style="background:${dt.bgColor};color:${dt.textColor};border:1px solid ${dt.color}40">${escapeHtml(dt.shortLabel)}</span>
        <div>
          <strong>${escapeHtml(dt.label)}</strong> <code style="font-size:10.5px;color:var(--text-muted)">(${dt.id})</code>
          <div style="font-size:11px;color:var(--text-muted)">
            ${scopeLabels[dt.dayScope] || dt.dayScope} • ${dt.autoAssign ? 'Auto-assignable' : 'Sur désidérata/repos'}
          </div>
        </div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-danger-ghost btn-xs" data-delete-type="${dt.id}" title="Supprimer ce type">✕</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-delete-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-delete-type');
      if (state.dayTypes.length <= 2) {
        alert('Il doit rester au moins 2 types de journées.');
        return;
      }
      state.dayTypes = state.dayTypes.filter(x => x.id !== id);
      saveAppState(state);
      renderRuleDynamicParams();
      runScheduleGenerator({ isAlternative: false });
    });
  });
}

function renderRulesDrawer() {
  const container = document.getElementById('rules-list');
  if (state.rules.length === 0) {
    container.innerHTML = `<p class="help-text">Aucune règle configurée.</p>`;
    return;
  }

  container.innerHTML = state.rules.map(rule => {
    const summary = summarizeRuleParams(rule, state.dayTypes, state.members);
    return `
      <div class="rule-item ${rule.enabled === false ? 'disabled' : ''}">
        <div class="rule-item-main">
          <input type="checkbox" data-toggle-rule="${rule.id}" ${rule.enabled !== false ? 'checked' : ''} style="margin-top:3px;" />
          <div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <strong>${escapeHtml(rule.name)}</strong>
              <span class="rule-badge ${rule.severity === 'soft' ? 'soft' : 'hard'}">
                ${rule.severity === 'soft' ? 'Souhaitable' : 'Stricte'}
              </span>
              <code style="font-size:11px;color:var(--text-light)">${rule.kind}</code>
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
              ${escapeHtml(summary)}
            </div>
          </div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-danger-ghost btn-xs" data-delete-rule="${rule.id}" title="Supprimer cette règle">✕</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-toggle-rule]').forEach(cb => {
    cb.addEventListener('change', () => {
      const r = state.rules.find(x => x.id === cb.getAttribute('data-toggle-rule'));
      if (r) {
        r.enabled = cb.checked;
        saveAppState(state);
        runScheduleGenerator({ isAlternative: false });
      }
    });
  });

  container.querySelectorAll('[data-delete-rule]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-delete-rule');
      state.rules = state.rules.filter(x => x.id !== id);
      saveAppState(state);
      runScheduleGenerator({ isAlternative: false });
    });
  });
}

function renderDesiderataDrawer() {
  const container = document.getElementById('desiderata-list');
  const entries = Object.entries(state.desiderata || {}).filter(
    ([, d]) => d && (d.requiredType || (Array.isArray(d.forbiddenTypes) && d.forbiddenTypes.length > 0))
  ).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    container.innerHTML = `<p class="help-text">Aucun désidérata enregistré. Cliquez sur un membre dans le calendrier pour en ajouter.</p>`;
    return;
  }

  container.innerHTML = entries.map(([key, des]) => {
    const [dateIso, memberId] = key.split('__');
    const member = state.members.find(m => m.id === memberId);
    const memberName = member ? member.name : memberId;

    let descHtml = '';
    if (des.requiredType) {
      const dt = state.dayTypes.find(d => d.id === des.requiredType);
      descHtml = `<span style="color:#1e40af;font-weight:600;">Demandé : ${escapeHtml(dt ? dt.label : des.requiredType)}</span>`;
    } else if (des.forbiddenTypes?.length > 0) {
      const names = des.forbiddenTypes.map(t => {
        const dt = state.dayTypes.find(d => d.id === t);
        return dt ? dt.shortLabel : t;
      }).join(', ');
      descHtml = `<span style="color:#991b1b;font-weight:600;">Interdit : Pas de ${escapeHtml(names)}</span>`;
    }

    return `
      <div class="item-card">
        <div>
          <div><strong>${escapeHtml(memberName)}</strong> — <span style="font-size:12px;color:var(--text-muted)">${formatDateHuman(dateIso)}</span></div>
          <div style="font-size:12px;margin-top:2px;">${descHtml}</div>
        </div>
        <button type="button" class="btn btn-danger-ghost btn-xs" data-remove-des="${key}" title="Supprimer ce désidérata">✕</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-remove-des]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-remove-des');
      delete state.desiderata[key];
      saveAppState(state);
      runScheduleGenerator({ isAlternative: false });
    });
  });
}

/**
 * Rendu du calendrier principal : UNE SEMAINE PAR LIGNE (7 colonnes Lun->Dim).
 * Par défaut, les lignes dans chaque jour sont triées par type de journée (state.calendarSort === 'type').
 */
function renderCalendar() {
  const body = document.getElementById('calendar-weeks-body');
  const weeks = buildWeeksRows(state.startDate, state.endDate);
  const activeMembers = state.members.filter(m => m.active !== false);
  const prop = getCurrentProposal();
  const grid = prop ? prop.grid : {};
  const violations = prop?.evaluation?.hardViolations || [];

  const typeMap = new Map(state.dayTypes.map(dt => [dt.id, dt]));
  const typeOrderMap = new Map(state.dayTypes.map((dt, idx) => [dt.id, idx]));
  const memberOrderMap = new Map(activeMembers.map((m, idx) => [m.id, idx]));
  const sortByType = state.calendarSort !== 'member';

  body.innerHTML = weeks.map(week => {
    const startD = week.days[0];
    const endD = week.days[week.days.length - 1];
    const weekLabel = `${startD.dayNum} ${MONTHS_SHORT_FR[startD.monthNum - 1]} – ${endD.dayNum} ${MONTHS_SHORT_FR[endD.monthNum - 1]}`;

    const daysHtml = week.days.map(day => {
      const dayViolations = violations.filter(v => v.dateIso === day.iso);
      const hasViolation = dayViolations.length > 0;

      // Calcul des compteurs rapides du jour (ex: Bureau, TT, Garde)
      const counts = {};
      for (const m of activeMembers) {
        const assignedId = grid[day.iso]?.[m.id];
        if (assignedId) {
          counts[assignedId] = (counts[assignedId] || 0) + 1;
        }
      }

      const miniPillsHtml = state.dayTypes
        .filter(dt => counts[dt.id] > 0 && dt.isWorkingDay)
        .map(dt => `
          <span class="quota-mini-pill" style="background:${dt.bgColor};color:${dt.textColor};border:1px solid ${dt.color}55;" title="${escapeHtml(dt.label)} : ${counts[dt.id]}">
            ${counts[dt.id]}
          </span>
        `).join('');

      // Tri des membres du jour : par type de journée (défaut) ou par personne
      const sortedMembersForDay = sortByType
        ? [...activeMembers].sort((a, b) => {
            const tA = grid[day.iso]?.[a.id];
            const tB = grid[day.iso]?.[b.id];
            const oA = tA !== undefined && typeOrderMap.has(tA) ? typeOrderMap.get(tA) : 999;
            const oB = tB !== undefined && typeOrderMap.has(tB) ? typeOrderMap.get(tB) : 999;
            if (oA !== oB) return oA - oB;
            return (memberOrderMap.get(a.id) ?? 0) - (memberOrderMap.get(b.id) ?? 0);
          })
        : activeMembers;

      const membersHtml = sortedMembersForDay.map(m => {
        const key = `${day.iso}__${m.id}`;
        const des = state.desiderata?.[key];
        const assignedId = grid[day.iso]?.[m.id];
        const dt = typeMap.get(assignedId);

        let slotClass = 'member-slot';
        let desIconHtml = '';
        let desTooltip = '';

        if (des?.requiredType) {
          slotClass += ' has-desiderata-req';
          const reqDt = typeMap.get(des.requiredType);
          desIconHtml = `<span class="des-icon" title="Désidérata fixé : ${reqDt ? reqDt.label : des.requiredType}">🔒</span>`;
          desTooltip = `Désidérata fixé : ${reqDt ? reqDt.label : des.requiredType}`;
        } else if (des?.forbiddenTypes?.length > 0) {
          slotClass += ' has-desiderata-forbid';
          const fNames = des.forbiddenTypes.map(fid => typeMap.get(fid)?.shortLabel || fid).join(', ');
          desIconHtml = `<span class="des-icon" title="Interdit : Pas de ${fNames}">🚫</span>`;
          desTooltip = `Désidérata : Pas de ${fNames}`;
        }

        const badgeHtml = dt
          ? `<span class="type-badge" style="background:${dt.bgColor};color:${dt.textColor};border:1px solid ${dt.color}35">${escapeHtml(dt.shortLabel)}</span>`
          : `<span class="type-badge" style="background:#f1f5f9;color:#64748b">—</span>`;

        return `
          <button type="button" class="${slotClass}" data-cell-date="${day.iso}" data-cell-member="${m.id}" title="${escapeHtml(m.name)} (${formatDateHuman(day.iso)}) ${desTooltip}">
            <span class="member-slot-left">
              <span class="color-dot" style="background:${m.color || '#2563eb'};width:8px;height:8px;"></span>
              <span class="member-name-text">${escapeHtml(m.name)}</span>
              ${desIconHtml}
            </span>
            ${badgeHtml}
          </button>
        `;
      }).join('');

      let weekendCollapsedHtml = '';
      if (day.isWeekend) {
        // Personnes ayant un statut différent de REPOS (ou repos par défaut)
        const nonRestMembers = [];
        for (const m of activeMembers) {
          const assignedId = grid[day.iso]?.[m.id];
          const dt = typeMap.get(assignedId);
          if (assignedId && assignedId !== 'REPOS' && (!dt || !dt.isDefaultRest)) {
            nonRestMembers.push({ member: m, dayType: dt, typeId: assignedId });
          }
        }

        // Regrouper par type pour afficher les cases colorées chiffrées avec les noms au survol
        const nonRestByType = new Map();
        for (const item of nonRestMembers) {
          const tid = item.typeId;
          if (!nonRestByType.has(tid)) {
            nonRestByType.set(tid, { dayType: item.dayType, count: 0, members: [] });
          }
          const group = nonRestByType.get(tid);
          group.count++;
          group.members.push(item.member.name);
        }

        const weekendPillsHtml = Array.from(nonRestByType.values()).map(g => {
          const dt = g.dayType;
          const bg = dt ? dt.bgColor : '#e2e8f0';
          const fg = dt ? dt.textColor : '#1e293b';
          const border = dt ? `1px solid ${dt.color}55` : '1px solid #cbd5e1';
          const label = dt ? dt.label : 'Service';
          const tooltip = `${label} (${g.count}) :\n${g.members.join(', ')}`;
          return `
            <span class="quota-mini-pill weekend-duty-pill" style="background:${bg};color:${fg};border:${border};" title="${escapeHtml(tooltip)}">
              ${g.count}
            </span>
          `;
        }).join('');

        weekendCollapsedHtml = `
          <div class="weekend-collapsed-badge" title="Week-end replié. Cliquez pour déplier/replier les week-ends.">
            <span class="we-dow">${DOW_SHORT_FR[day.dow]}</span>
            <span class="we-day">${day.dayNum}</span>
            ${weekendPillsHtml ? `<div class="weekend-collapsed-pills">${weekendPillsHtml}</div>` : ''}
          </div>
        `;
      }

      const dateShortFormatted = `${String(day.dayNum).padStart(2, '0')}/${String(day.monthNum).padStart(2, '0')}`;

      return `
        <div class="day-cell ${day.isWeekend ? 'weekend' : 'weekday'} ${!day.inRange ? 'out-of-range' : ''} ${hasViolation ? 'has-violation' : ''}" data-day-iso="${day.iso}">
          <div class="day-cell-header">
            <span class="day-date-title">
              ${dateShortFormatted}
              ${hasViolation ? `<span title="${escapeHtml(dayViolations.map(v => v.message).join(' | '))}">⚠️</span>` : ''}
            </span>
            <div class="day-quotas-mini">${miniPillsHtml}</div>
          </div>
          ${weekendCollapsedHtml}
          <div class="day-members-list">
            ${membersHtml}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="week-row" role="row">
        <div class="week-label-cell">
          <div class="week-num">Sem. ${week.weekNumber}</div>
          <div class="week-dates">${weekLabel}</div>
        </div>
        ${daysHtml}
      </div>
    `;
  }).join('');

  updateWeekendsCollapsedState();

  // Permet de déplier en cliquant sur l'en-tête de colonne week-end ou une cellule de week-end repliée
  body.querySelectorAll('.day-cell.weekend').forEach(cell => {
    cell.addEventListener('click', (e) => {
      if (state.collapseWeekends && !e.target.closest('.member-slot')) {
        state.collapseWeekends = false;
        saveAppState(state);
        updateWeekendsCollapsedState();
      }
    });
  });

  document.querySelectorAll('.col-weekend').forEach(headerCol => {
    headerCol.addEventListener('click', () => {
      state.collapseWeekends = !state.collapseWeekends;
      saveAppState(state);
      updateWeekendsCollapsedState();
    });
  });

  // Écouteurs de clic sur chaque slot membre d'un jour
  body.querySelectorAll('[data-cell-date][data-cell-member]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dateIso = btn.getAttribute('data-cell-date');
      const memberId = btn.getAttribute('data-cell-member');
      handleCalendarCellClick(dateIso, memberId);
    });
  });
}

function updateWeekendsCollapsedState() {
  const container = document.querySelector('.calendar-container');
  const btnLabel = document.getElementById('btn-toggle-weekends-label');
  const isCollapsed = state.collapseWeekends !== false;

  if (container) {
    if (isCollapsed) {
      container.classList.add('weekends-collapsed');
    } else {
      container.classList.remove('weekends-collapsed');
    }
  }

  if (btnLabel) {
    btnLabel.textContent = isCollapsed ? 'Week-end (replié)' : 'Week-end (déplié)';
  }
}

function handleCalendarCellClick(dateIso, memberId) {
  const mode = document.getElementById('select-interaction-mode').value || 'inspect';
  const key = `${dateIso}__${memberId}`;

  if (mode === 'inspect') {
    openCellModal(dateIso, memberId);
    return;
  }

  if (mode === 'clear_des') {
    delete state.desiderata[key];
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
    return;
  }

  if (mode.startsWith('req:')) {
    const typeId = mode.slice(4);
    if (state.desiderata[key]?.requiredType === typeId) {
      delete state.desiderata[key];
    } else {
      state.desiderata[key] = { requiredType: typeId, forbiddenTypes: [] };
    }
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
    return;
  }

  if (mode.startsWith('forbid:')) {
    const typeId = mode.slice(7);
    const existing = state.desiderata[key] || { requiredType: null, forbiddenTypes: [] };
    existing.requiredType = null;
    const set = new Set(existing.forbiddenTypes || []);
    if (set.has(typeId)) {
      set.delete(typeId);
    } else {
      set.add(typeId);
    }
    if (set.size === 0) {
      delete state.desiderata[key];
    } else {
      state.desiderata[key] = { requiredType: null, forbiddenTypes: Array.from(set) };
    }
    saveAppState(state);
    runScheduleGenerator({ isAlternative: false });
  }
}

/**
 * Rendu de la bannière de conformité, de la légende et du tableau récapitulatif par membre.
 */
function renderSummaryAndStatus() {
  const banner = document.getElementById('schedule-status-banner');
  const violationsCard = document.getElementById('violations-card');
  const violationsList = document.getElementById('violations-list');
  const prop = getCurrentProposal();

  if (!prop || !prop.evaluation) {
    banner.className = 'status-banner';
    banner.textContent = 'Aucune proposition générée.';
    violationsCard.setAttribute('hidden', '');
    return;
  }

  const hardViolations = prop.evaluation.hardViolations || [];
  if (hardViolations.length === 0) {
    banner.className = 'status-banner ok';
    banner.innerHTML = `✅ Toutes les règles strictes (${state.rules.filter(r => r.enabled !== false && r.severity !== 'soft').length}) et tous les désidératas sont respectés.`;
    violationsCard.setAttribute('hidden', '');
  } else {
    banner.className = 'status-banner warn';
    banner.innerHTML = `⚠️ ${hardViolations.length} point(s) de conflit détecté(s) avec les règles ou désidératas (voir détails en bas de page).`;
    violationsCard.removeAttribute('hidden');
    violationsList.innerHTML = hardViolations.map(v => `<li>${escapeHtml(v.message)}</li>`).join('');
  }

  // Légende des types
  const legendContainer = document.getElementById('legend-pills');
  legendContainer.innerHTML = state.dayTypes.map(dt => `
    <span class="type-badge" style="background:${dt.bgColor};color:${dt.textColor};border:1px solid ${dt.color}40">
      ${escapeHtml(dt.shortLabel)} : ${escapeHtml(dt.label)}
    </span>
  `).join('');

  // Tableau récapitulatif par membre
  const table = document.getElementById('member-summary-table');
  const activeMembers = state.members.filter(m => m.active !== false);
  const stats = prop.stats;

  table.querySelector('thead').innerHTML = `
    <tr>
      <th>Membre</th>
      ${state.dayTypes.map(dt => `<th>${escapeHtml(dt.shortLabel)}</th>`).join('')}
      <th>Total jours travaillés</th>
    </tr>
  `;

  table.querySelector('tbody').innerHTML = activeMembers.map(m => {
    const mStats = stats?.byMember?.[m.id] || { totalWork: 0, byType: {} };
    return `
      <tr>
        <td>
          <span class="color-dot" style="display:inline-block;background:${m.color || '#2563eb'};margin-right:6px;vertical-align:middle;"></span>
          ${escapeHtml(m.name)}
        </td>
        ${state.dayTypes.map(dt => {
          const val = mStats.byType[dt.id] || 0;
          return `<td>${val > 0 ? `<span class="type-badge" style="background:${dt.bgColor};color:${dt.textColor}">${val}</span>` : '<span style="color:#cbd5e1">0</span>'}</td>`;
        }).join('')}
        <td><strong>${mStats.totalWork} j.</strong></td>
      </tr>
    `;
  }).join('');
}

/**
 * Modale contextuelle pour une case (Membre x Date) :
 * 1. Saisie de désidérata (demander un type ou interdire certains types)
 * 2. Exploration et changement d'affectation dans la proposition courante (avec vérification des règles)
 */
function bindModalEvents() {
  const backdrop = document.getElementById('cell-modal-backdrop');
  document.getElementById('btn-close-cell-modal').addEventListener('click', closeCellModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeCellModal();
  });

  document.getElementById('btn-clear-cell-des').addEventListener('click', () => {
    if (!activeModalCell) return;
    const key = `${activeModalCell.dateIso}__${activeModalCell.memberId}`;
    delete state.desiderata[key];
    saveAppState(state);
    refreshCurrentProposalEvaluation();
    renderCellModalContent();
    renderAll();
  });

  document.getElementById('btn-apply-des-and-solve').addEventListener('click', () => {
    closeCellModal();
    runScheduleGenerator({ isAlternative: false });
  });

  // Modale Backup JSON
  const backupBackdrop = document.getElementById('backup-modal-backdrop');
  document.getElementById('btn-close-backup-modal').addEventListener('click', () => {
    backupBackdrop.setAttribute('hidden', '');
  });
  backupBackdrop.addEventListener('click', (e) => {
    if (e.target === backupBackdrop) backupBackdrop.setAttribute('hidden', '');
  });

  document.getElementById('btn-download-json-file').addEventListener('click', () => {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `horaires-equipe-${state.startDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('input-upload-json-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('backup-json-textarea').value = String(reader.result || '');
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-restore-from-textarea').addEventListener('click', () => {
    try {
      const raw = document.getElementById('backup-json-textarea').value;
      const parsed = JSON.parse(raw);
      if (!parsed.members || !parsed.dayTypes) {
        throw new Error('Format JSON incomplet (propriétés members et dayTypes attendues).');
      }
      saveAppState(parsed);
      state = loadAppState();
      backupBackdrop.setAttribute('hidden', '');
      runScheduleGenerator({ isAlternative: false });
    } catch (err) {
      alert(`Erreur lors de l'import JSON : ${err.message}`);
    }
  });
}

function openCellModal(dateIso, memberId) {
  activeModalCell = { dateIso, memberId };
  renderCellModalContent();
  document.getElementById('cell-modal-backdrop').removeAttribute('hidden');
}

function closeCellModal() {
  activeModalCell = null;
  document.getElementById('cell-modal-backdrop').setAttribute('hidden', '');
}

function renderCellModalContent() {
  if (!activeModalCell) return;
  const { dateIso, memberId } = activeModalCell;
  const member = state.members.find(m => m.id === memberId);
  const prop = getCurrentProposal();
  const currentTypeId = prop?.grid?.[dateIso]?.[memberId];
  const currentTypeObj = state.dayTypes.find(d => d.id === currentTypeId);

  document.getElementById('cell-modal-title').textContent = `${member ? member.name : memberId} — ${formatDateHuman(dateIso)}`;
  document.getElementById('cell-modal-subtitle').textContent =
    `Affectation actuelle dans la proposition : ${currentTypeObj ? currentTypeObj.label : 'Aucune'}`;

  const key = `${dateIso}__${memberId}`;
  const des = state.desiderata[key] || { requiredType: null, forbiddenTypes: [] };

  // 1. Boutons "Fixer / Demander ce type"
  const reqContainer = document.getElementById('modal-des-require-list');
  reqContainer.innerHTML = state.dayTypes.map(dt => {
    const isActive = des.requiredType === dt.id;
    return `
      <button type="button" class="chip-btn ${isActive ? 'active-req' : ''}" data-modal-req="${dt.id}">
        ${isActive ? '🔒 ' : ''}${escapeHtml(dt.label)}
      </button>
    `;
  }).join('');

  reqContainer.querySelectorAll('[data-modal-req]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tid = btn.getAttribute('data-modal-req');
      if (state.desiderata[key]?.requiredType === tid) {
        delete state.desiderata[key];
      } else {
        state.desiderata[key] = { requiredType: tid, forbiddenTypes: [] };
      }
      saveAppState(state);
      refreshCurrentProposalEvaluation();
      renderCellModalContent();
      renderAll();
    });
  });

  // 2. Boutons "Interdire (Pas de...)"
  const forbidContainer = document.getElementById('modal-des-forbid-list');
  forbidContainer.innerHTML = state.dayTypes.map(dt => {
    const isForbidden = Array.isArray(des.forbiddenTypes) && des.forbiddenTypes.includes(dt.id);
    return `
      <button type="button" class="chip-btn ${isForbidden ? 'active-forbid' : ''}" data-modal-forbid="${dt.id}">
        ${isForbidden ? '🚫 Pas de ' : ''}${escapeHtml(dt.shortLabel)}
      </button>
    `;
  }).join('');

  forbidContainer.querySelectorAll('[data-modal-forbid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tid = btn.getAttribute('data-modal-forbid');
      const cur = state.desiderata[key] || { requiredType: null, forbiddenTypes: [] };
      cur.requiredType = null;
      const set = new Set(cur.forbiddenTypes || []);
      if (set.has(tid)) {
        set.delete(tid);
      } else {
        set.add(tid);
      }
      if (set.size === 0) {
        delete state.desiderata[key];
      } else {
        state.desiderata[key] = { requiredType: null, forbiddenTypes: Array.from(set) };
      }
      saveAppState(state);
      refreshCurrentProposalEvaluation();
      renderCellModalContent();
      renderAll();
    });
  });

  // 3. Analyse des alternatives dans la proposition actuelle
  const altContainer = document.getElementById('modal-alternatives-list');
  if (!prop) {
    altContainer.innerHTML = `<p class="help-text">Générez d'abord une proposition d'horaire.</p>`;
    return;
  }

  const dateISOs = getEffectiveDateISOs();
  const alternatives = analyzeCellAlternatives({
    grid: prop.grid,
    dateISOs,
    dateIso,
    memberId,
    members: state.members,
    dayTypes: state.dayTypes,
    rules: state.rules,
    desiderata: state.desiderata
  });

  altContainer.innerHTML = alternatives.map(alt => {
    const dt = alt.dayType;
    let statusHtml = '';
    if (alt.isCurrent) {
      statusHtml = `<span class="alt-status valid">● Affectation actuelle</span>`;
    } else if (alt.directValid) {
      statusHtml = `<span class="alt-status valid">✅ Compatible directement avec toutes les règles</span>`;
    } else {
      const reasons = alt.relevantViolations.map(v => v.message).join(' • ') || `${alt.hardViolationsCount} conflit(s) de règles`;
      statusHtml = `<span class="alt-status conflict">⚠️ Impact direct : ${escapeHtml(reasons)}</span>`;
    }

    return `
      <div class="alt-item ${alt.isCurrent ? 'current' : ''}">
        <div class="alt-left">
          <div>
            <span class="type-badge" style="background:${dt.bgColor};color:${dt.textColor};border:1px solid ${dt.color}40">
              ${escapeHtml(dt.shortLabel)}
            </span>
            <strong style="margin-left:6px;">${escapeHtml(dt.label)}</strong>
          </div>
          ${statusHtml}
        </div>
        <div class="alt-actions">
          ${alt.isCurrent ? '' : `
            <button type="button" class="btn ${alt.directValid ? 'btn-primary' : 'btn-outline'} btn-xs" data-apply-direct="${dt.id}">
              ${alt.directValid ? 'Choisir' : 'Forcer'}
            </button>
            ${(!alt.directValid && alt.scopeCompatible) ? `
              <button type="button" class="btn btn-secondary btn-xs" data-apply-rebalance="${dt.id}" title="Ajuste automatiquement un collègue pour respecter toutes les règles">
                🔄 Choisir & ré-équilibrer
              </button>
            ` : ''}
          `}
        </div>
      </div>
    `;
  }).join('');

  altContainer.querySelectorAll('[data-apply-direct]').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTypeId = btn.getAttribute('data-apply-direct');
      if (!prop.grid[dateIso]) prop.grid[dateIso] = {};
      prop.grid[dateIso][memberId] = newTypeId;
      refreshCurrentProposalEvaluation();
      saveAppState(state);
      renderCellModalContent();
      renderAll();
    });
  });

  altContainer.querySelectorAll('[data-apply-rebalance]').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTypeId = btn.getAttribute('data-apply-rebalance');
      const reopt = reoptimizeAroundCellChange({
        currentGrid: prop.grid,
        dateISOs,
        dateIso,
        memberId,
        newTypeId,
        members: state.members,
        dayTypes: state.dayTypes,
        rules: state.rules,
        desiderata: state.desiderata
      });
      prop.grid = reopt.grid;
      prop.evaluation = reopt.evaluation;
      prop.stats = reopt.stats;
      saveAppState(state);
      closeCellModal();
      renderAll();
    });
  });
}

function openBackupModal() {
  document.getElementById('backup-json-textarea').value = JSON.stringify(state, null, 2);
  document.getElementById('backup-modal-backdrop').removeAttribute('hidden');
}

function exportCurrentScheduleCSV() {
  const prop = getCurrentProposal();
  if (!prop) return;
  const dateISOs = getEffectiveDateISOs();
  const activeMembers = state.members.filter(m => m.active !== false);
  const typeMap = new Map(state.dayTypes.map(d => [d.id, d.label]));

  const header = ['Date', 'Jour', ...activeMembers.map(m => m.name)];
  const rows = [header];

  for (const iso of dateISOs) {
    const [y, m, d] = iso.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d, 12, 0, 0);
    const dowName = DAY_NAMES_FR[dateObj.getDay()];
    const row = [
      iso,
      dowName,
      ...activeMembers.map(mem => {
        const tid = prop.grid[iso]?.[mem.id] || '';
        return typeMap.get(tid) || tid;
      })
    ];
    rows.push(row);
  }

  const csvContent = '\uFEFF' + rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `horaire-${state.startDate}-au-${state.endDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDateHuman(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d, 12, 0, 0);
  return `${DAY_NAMES_FR[dateObj.getDay()]} ${d} ${MONTHS_SHORT_FR[m - 1]} ${y}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
