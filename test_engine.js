// Smoke test the dynamic engine

const fs = require('fs');
const path = require('path');

// Pull the script out
const html = fs.readFileSync('/home/claude/current.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let script = m[1];

// Stub out the DOM-bound bits that would crash in node
const stub = `
const localStorage = { _store: {}, getItem(k) { return this._store[k] || null; }, setItem(k, v) { this._store[k] = v; }, removeItem(k) { delete this._store[k]; } };
const document = {
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById() { return null; }, createElement() { return { addEventListener(){}, click(){}, style:{} }; },
  body: { addEventListener(){} }
};
const window = { addEventListener() {}, location: { href: '' } };
const alert = (msg) => console.log('[alert]', msg);
const confirm = (msg) => { console.log('[confirm]', msg); return true; };
const URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
const Blob = function(){};
const FileReader = function(){};
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const setTimeout = (fn) => fn();
`;

// Strip top-level boot calls by removing the auto-bootstrap section
script = script.replace(/safeClockTick\(\);[\s\S]*?if \(state\.ui\?\.needsSetup\)[^\n]*\n/g, '');
script = script.replace(/save\(\); \/\/ persist migrated schema immediately/, '/* test mode: skip immediate save */');
// Truncate at the first .addEventListener call outside of function bodies
const cutAt = script.indexOf("$('#tk-newBtn').addEventListener");
if (cutAt > 0) script = script.slice(0, cutAt);

// Wrap into module
const program = stub + '\n' + script + '\n' + `
// === TESTS ===
function assert(cond, msg) {
  if (!cond) { console.log('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

console.log('\\n--- Test 1: seed schema augmented correctly ---');
assert(SEED_TASKS.length > 50, 'seed tasks present');
const cvSeed = SEED_TASKS.find(s => s.id === 'cv-personalize');
assert(cvSeed && cvSeed.estMinutes === 90, 'cv-personalize has estMinutes');
assert(cvSeed.criticality === 'high', 'cv-personalize is high criticality');
const linkedinSeed = SEED_TASKS.find(s => s.id === 'linkedin-fix');
assert(linkedinSeed.deps.includes('cv-personalize'), 'linkedin-fix depends on cv-personalize');

console.log('\\n--- Test 2: task creation and dependency lookup ---');
const cvTask = state.tasks.find(t => t.seedId === 'cv-personalize');
const liTask = state.tasks.find(t => t.seedId === 'linkedin-fix');
assert(cvTask, 'cv task created with seedId');
assert(liTask && liTask.deps.includes('cv-personalize'), 'linkedin task carries deps');
assert(getTaskBySeedId('cv-personalize') === cvTask, 'getTaskBySeedId works');

console.log('\\n--- Test 3: dependency cascade ---');
// Move cv-personalize from its date to a date 10 days later
const oldDate = cvTask.dueDate;
const newDate = addDays(oldDate, 10);
cvTask.dueDate = newDate;
const moves = cascadeForward('cv-personalize');
assert(moves.length > 0, 'cascade moved at least one dependent');
const linkedinAfter = state.tasks.find(t => t.seedId === 'linkedin-fix');
assert(linkedinAfter.dueDate >= newDate || dayDiff(newDate, linkedinAfter.dueDate) >= 0, 'linkedin pushed forward');

console.log('\\n--- Test 4: severity uses criticality ---');
// Use a recently-overdue task (low base score) so the multiplier matters.
const recent = new Date(Date.now() - 4 * 3600 * 1000); // 4 hours ago
const pad = (n) => String(n).padStart(2, '0');
const recentDate = recent.getFullYear() + '-' + pad(recent.getMonth()+1) + '-' + pad(recent.getDate());
const recentTime = pad(recent.getHours()) + ':' + pad(recent.getMinutes());
const critTask = { id: 'a', dueDate: recentDate, dueTime: recentTime, status: 'pending', category: 'cv', criticality: 'critical' };
const normTask = { id: 'b', dueDate: recentDate, dueTime: recentTime, status: 'pending', category: 'cv', criticality: 'normal' };
const lowTask  = { id: 'c', dueDate: recentDate, dueTime: recentTime, status: 'pending', category: 'cv', criticality: 'low' };
const critScore = taskSeverityScore(critTask);
const normScore = taskSeverityScore(normTask);
const lowScore  = taskSeverityScore(lowTask);
assert(critScore > normScore, 'critical task scores higher than normal: ' + critScore + ' vs ' + normScore);
assert(normScore > lowScore, 'normal task scores higher than low: ' + normScore + ' vs ' + lowScore);

console.log('\\n--- Test 5: projection engine ---');
// Mock some recent completions
state.tasks[0].status = 'done';
state.tasks[0].completedAt = todayISO();
const proj = getProjection('cv');
assert(proj && typeof proj.requiredRate === 'number', 'projection produces required rate');
assert('paceSufficient' in proj, 'projection has paceSufficient');

console.log('\\n--- Test 6: time budget total ---');
const budget = getTimeBudgetTotal();
assert(budget.totalMinutes > 0, 'time budget has total minutes');
assert(budget.taskCount > 0, 'time budget has task count');
assert(typeof budget.utilization === 'number', 'budget computes utilization');

console.log('\\n--- Test 7: ritual streak handles no-data gracefully ---');
const rs = getRitualStreak('coding');
assert(rs >= 0, 'ritual streak returns a number: ' + rs);

console.log('\\n--- Test 8: defer milestone updates settings ---');
const oldDeploy = state.settings.deployDeadline;
deferMilestone('deploy', 7);
assert(state.settings.deployDeadline !== oldDeploy, 'deploy deadline updated by deferMilestone');

console.log('\\n--- Test 9: catch-up staggering ---');
const slots = computeStaggeredSlots(4);
assert(slots.length === 4, 'computed 4 slots');
assert(slots.every(s => /^\\d{2}:\\d{2}$/.test(s)), 'slots are valid HH:MM');
// They should not all be the same
const unique = new Set(slots);
assert(unique.size > 1, 'slots are staggered: ' + slots.join(', '));

console.log('\\n--- Test 10: rescheduleSeedTasks with cascade ---');
state.settings.cvDeadline = '2026-05-15';  // shift CV deadline 11 days later
rescheduleSeedTasks(false);
const mCv = state.tasks.find(t => t.seedId === 'M-cv');
assert(mCv.dueDate === '2026-05-15', 'milestone M-cv tracks setting: ' + mCv.dueDate);

console.log('\\nAll tests passed.');
`;

fs.writeFileSync('/tmp/test_engine.js', program);
require('/tmp/test_engine.js');
