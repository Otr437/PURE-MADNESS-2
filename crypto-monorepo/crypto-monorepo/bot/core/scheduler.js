'use strict';

/**
 * bot/core/scheduler.js
 * Cron-style recurring task scheduler for autonomous operations.
 *
 * Tasks are persisted to disk (JSON) so they survive restarts.
 * The scheduler runs its own setInterval tick loop.
 *
 * Pure Node.js — no external deps.
 *
 * Task shape:
 * {
 *   id:          string,
 *   name:        string,
 *   goal:        string,        // natural-language goal passed to the agent
 *   intervalMs:  number,        // how often to run
 *   lastRunAt:   number|null,   // epoch ms
 *   nextRunAt:   number,        // epoch ms
 *   runCount:    number,
 *   enabled:     boolean,
 *   createdAt:   number,
 *   maxRuns:     number|null,   // null = run forever
 * }
 */

const fs     = require('fs');
const crypto = require('crypto');
const CONFIG = require('../config/config');
const { audit } = require('./audit');

const SCHED_FILE = CONFIG.schedulerFile;
const TICK_MS    = CONFIG.schedulerTickMs;

let _tasks   = new Map();  // id → task
let _timer   = null;
let _agentFn = null;       // injected: async (goal) => { answer }

// ── Persistence ───────────────────────────────────────────────────────────────

function _saveTasks() {
  const arr = [..._tasks.values()];
  fs.writeFileSync(SCHED_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function _loadTasks() {
  if (!fs.existsSync(SCHED_FILE)) return;
  try {
    const arr = JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8'));
    for (const t of arr) _tasks.set(t.id, t);
  } catch { /* corrupted — start fresh */ }
}

_loadTasks();

// ── Task management ───────────────────────────────────────────────────────────

/**
 * Add a recurring task.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.goal         Natural-language goal for the agent.
 * @param {number} opts.intervalMs   Run every N milliseconds.
 * @param {number} [opts.maxRuns]    Stop after N runs (default: unlimited).
 * @param {number} [opts.delayMs=0]  Delay first run by N ms.
 * @returns {object} task
 */
function addTask({ name, goal, intervalMs, maxRuns = null, delayMs = 0 }) {
  const id   = crypto.randomBytes(4).toString('hex');
  const now  = Date.now();
  const task = {
    id,
    name,
    goal,
    intervalMs,
    lastRunAt:  null,
    nextRunAt:  now + delayMs,
    runCount:   0,
    enabled:    true,
    createdAt:  now,
    maxRuns,
  };
  _tasks.set(id, task);
  _saveTasks();
  audit('scheduler.add', { id, name, intervalMs, maxRuns });
  return task;
}

/**
 * Remove a task by id.
 */
function removeTask(id) {
  _tasks.delete(id);
  _saveTasks();
  audit('scheduler.remove', { id });
}

/**
 * Enable or disable a task.
 */
function setEnabled(id, enabled) {
  const task = _tasks.get(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  task.enabled = enabled;
  _saveTasks();
}

/**
 * List all tasks.
 * @returns {object[]}
 */
function listTasks() {
  return [..._tasks.values()];
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function _tick() {
  const now = Date.now();
  for (const [id, task] of _tasks) {
    if (!task.enabled)          continue;
    if (task.nextRunAt > now)   continue;
    if (!_agentFn)              continue;

    // Check maxRuns
    if (task.maxRuns !== null && task.runCount >= task.maxRuns) {
      task.enabled = false;
      _saveTasks();
      continue;
    }

    // Run
    task.lastRunAt = now;
    task.runCount++;
    task.nextRunAt = now + task.intervalMs;
    _saveTasks();

    audit('scheduler.run', { id, name: task.name, runCount: task.runCount });

    try {
      const result = await _agentFn(task.goal);
      audit('scheduler.complete', { id, name: task.name, answer: result?.answer?.slice(0, 100) });
    } catch (err) {
      audit('scheduler.error', { id, name: task.name, error: err.message });
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start the scheduler tick loop.
 * @param {Function} agentRunFn  async (goal: string) => { answer: string }
 */
function start(agentRunFn) {
  if (_timer) return; // already running
  _agentFn = agentRunFn;
  _timer   = setInterval(_tick, TICK_MS);
  // Don't block process exit
  if (_timer.unref) _timer.unref();
  audit('scheduler.start', { taskCount: _tasks.size, tickMs: TICK_MS });
}

/**
 * Stop the scheduler.
 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  audit('scheduler.stop', {});
}

/**
 * Force an immediate tick (useful for testing).
 */
async function tick() { await _tick(); }

module.exports = { addTask, removeTask, setEnabled, listTasks, start, stop, tick };
