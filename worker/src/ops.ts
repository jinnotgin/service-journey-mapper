// Phase 9 — atomic op-based sync: shared op-apply logic.
//
// The server keeps a whole-document snapshot as its source of truth (hydrate +
// storage + size cap unchanged). Instead of accepting a whole-`journeys` push,
// it applies each granular op TO that snapshot here and re-broadcasts the op.
//
// This module MUST converge with the client's identical `applyOp` (ported into
// index.html). Both reference entities by their stable Phase-7 `id` (never an
// array index) and reuse the same leaf-index / normalize / divider helpers so a
// structural op produces a byte-identical tree on every peer. Ops that mint new
// cells (column.insert / row.insert) carry the minted ids in the payload, so the
// server and all clients use the same ids — convergence does not depend on each
// peer minting its own.
//
// Two op classes (see docs/collab-sync.md "Phase 9"):
//   A. cell.set        — content, commutative, per-cell LWW by `ts`. Not version-gated.
//   B. everything else  — structural, serialized through the global `version`.
//
// `applyOp` returns the NEXT journeys array (a shallow-cloned, structurally-new
// tree on success) or `null` when the op cannot be applied cleanly (unknown id,
// malformed). A `null` return is the caller's signal to fall back to a full
// `doc.reject` resync — the universal convergence backstop.

const DIVIDER_TYPE = "row-divider";

// ── minimal typed views of the snapshot (loose; the doc is otherwise opaque) ──
interface Cell {
  id?: string;
  mode?: string;
  html?: string;
  align?: string;
  colspan?: number;
  tags?: unknown;
  [k: string]: unknown;
}
interface Row {
  id?: string;
  rowType?: string;
  laneLabel?: string;
  customColor?: string;
  cells?: Cell[];
  [k: string]: unknown;
}
interface SubJourney {
  id?: string;
  rows?: Row[];
  [k: string]: unknown;
}
interface Stage {
  id?: string;
  title?: string;
  num?: unknown;
  subStages?: Stage[];
  [k: string]: unknown;
}
interface Journey {
  id?: string;
  stages?: Stage[];
  subJourneys?: SubJourney[];
  [k: string]: unknown;
}

export interface Op {
  t: string;
  ts?: number;
  [k: string]: unknown;
}

// ── structure helpers (mirror of index.html STRUCTURE HELPERS) ───────────────
const leafCount = (stage: Stage): number => Math.max(stage?.subStages?.length || 0, 1);
const totalLeaves = (stages: Stage[]): number => (stages || []).reduce((n, s) => n + leafCount(s), 0);
const leafStart = (stages: Stage[], stageIdx: number): number =>
  (stages || []).slice(0, stageIdx).reduce((n, s) => n + leafCount(s), 0);

const rowWidth = (cells: Cell[]): number => (cells || []).reduce((a, c) => a + (c.colspan || 1), 0);

function moveArrayRange<T>(items: T[], from: number, count: number, to: number): T[] {
  if (count <= 0 || from === to || from < 0 || from >= items.length) return items;
  const safeCount = Math.min(count, items.length - from);
  const insertAtOriginal = Math.max(0, Math.min(to, items.length));
  if (insertAtOriginal >= from && insertAtOriginal <= from + safeCount) return items;
  const next = items.slice();
  const moved = next.splice(from, safeCount);
  const insertAt = insertAtOriginal > from ? insertAtOriginal - safeCount : insertAtOriginal;
  next.splice(insertAt, 0, ...moved);
  return next;
}

function cellsToLeafCells(cells: Cell[]): Array<Cell & { __spanKey?: string }> {
  const leaves: Array<Cell & { __spanKey?: string }> = [];
  (cells || []).forEach((cell, cellIdx) => {
    const w = cell.colspan || 1;
    const base: Cell = { ...cell };
    delete base.colspan;
    for (let i = 0; i < w; i++) leaves.push({ ...base, __spanKey: `${cellIdx}` });
  });
  return leaves;
}

function leafCellsToCells(leaves: Array<Cell & { __spanKey?: string }>, mintId: () => string): Cell[] {
  const out: Array<Cell & { __spanKey?: string }> = [];
  const usedIds = new Set<string>();
  (leaves || []).forEach((leaf) => {
    const { __spanKey, ...cell } = leaf;
    const last = out[out.length - 1];
    if (last && last.__spanKey === __spanKey) {
      last.colspan = (last.colspan || 1) + 1;
    } else {
      if (cell.id && usedIds.has(cell.id)) cell.id = mintId();
      if (cell.id) usedIds.add(cell.id);
      out.push({ ...cell, __spanKey, colspan: 1 });
    }
  });
  return out.map(({ __spanKey, ...cell }) => {
    if (cell.colspan === 1) delete cell.colspan;
    return cell as Cell;
  });
}

function moveLeafRangeInRow(row: Row, from: number, count: number, to: number, mintId: () => string): Row {
  if (row.rowType === DIVIDER_TYPE) return row;
  const leaves = cellsToLeafCells(row.cells || []);
  const moved = moveArrayRange(leaves, from, count, to);
  if (moved === leaves) return row;
  return { ...row, cells: leafCellsToCells(moved, mintId) };
}

// Insert one leaf column at global leaf index `at`, optionally with a caller-
// supplied cell id (so the server and all clients mint the SAME id).
function insertLeafIntoRow(cells: Cell[], at: number, newCellId?: string): Cell[] {
  const fresh = (): Cell => ({ id: newCellId || rid(), mode: "text", html: "", align: "left" });
  let pos = 0;
  for (let i = 0; i < cells.length; i++) {
    const w = cells[i].colspan || 1;
    if (at < pos + w) {
      const nc = cells.slice();
      if (at === pos) nc.splice(i, 0, fresh());
      else nc[i] = { ...nc[i], colspan: w + 1 };
      return nc;
    }
    pos += w;
  }
  return [...cells, fresh()];
}

function removeLeafFromRow(cells: Cell[], at: number): Cell[] {
  let pos = 0;
  for (let i = 0; i < cells.length; i++) {
    const w = cells[i].colspan || 1;
    if (at < pos + w) {
      const nc = cells.slice();
      if (w > 1) {
        const cell: Cell = { ...nc[i], colspan: w - 1 };
        if (cell.colspan === 1) delete cell.colspan;
        nc[i] = cell;
      } else nc.splice(i, 1);
      return nc;
    }
    pos += w;
  }
  return cells;
}

function normalizeRowCells(cells: Cell[], total: number, mintId: () => string): Cell[] {
  let w = rowWidth(cells);
  if (w === total) return cells;
  const nc = cells.slice();
  while (w < total) {
    nc.push({ id: mintId(), mode: "text", html: "", align: "left" });
    w++;
  }
  while (w > total && nc.length) {
    const last = nc[nc.length - 1];
    const lw = last.colspan || 1;
    if (lw > 1) {
      const c: Cell = { ...last, colspan: lw - 1 };
      if (c.colspan === 1) delete c.colspan;
      nc[nc.length - 1] = c;
    } else nc.pop();
    w--;
  }
  return nc;
}

function collapseDivider(cells: Cell[], total: number, mintId: () => string): Cell[] {
  const first = cells[0] || { id: mintId() };
  const c: Cell = { id: first.id || mintId(), mode: "text", html: first.html ?? "", align: first.align || "center" };
  if (total > 1) c.colspan = total;
  return [c];
}

function expandDivider(cells: Cell[], total: number, mintId: () => string): Cell[] {
  const first: Cell = { ...(cells[0] || { id: mintId() }) };
  if (!first.id) first.id = mintId();
  delete first.colspan;
  return normalizeRowCells([first], total, mintId);
}

// Fallback id when an op did not carry one. Server-minted ids only ever appear in
// the rare path where an op omits a needed id (it shouldn't); the client mints
// and ships ids for every new entity, so in practice these are deterministic.
function rid(): string {
  return `e_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ── lookups by id ────────────────────────────────────────────────────────────
function findJourney(journeys: Journey[], journeyId: string): { idx: number; j: Journey } | null {
  const idx = journeys.findIndex((j) => j.id === journeyId);
  return idx < 0 ? null : { idx, j: journeys[idx] };
}
function findSubJourney(j: Journey, sjId: string): { idx: number; sj: SubJourney } | null {
  const idx = (j.subJourneys || []).findIndex((sj) => sj.id === sjId);
  return idx < 0 ? null : { idx, sj: j.subJourneys![idx] };
}
// Find the journey + sub-journey + row containing a row id.
function locateRow(
  journeys: Journey[],
  rowId: string,
): { jIdx: number; sjIdx: number; rowIdx: number } | null {
  for (let jIdx = 0; jIdx < journeys.length; jIdx++) {
    const sjs = journeys[jIdx].subJourneys || [];
    for (let sjIdx = 0; sjIdx < sjs.length; sjIdx++) {
      const rows = sjs[sjIdx].rows || [];
      const rowIdx = rows.findIndex((r) => r.id === rowId);
      if (rowIdx >= 0) return { jIdx, sjIdx, rowIdx };
    }
  }
  return null;
}
// Find a stage's index within a journey's top-level stages (columns live here).
function stageIndexById(stages: Stage[], stageId: string): number {
  return stages.findIndex((s) => s.id === stageId);
}
// The global leaf index of a top-level "column" (a stage's leaf). Because a stage
// with sub-stages contributes one leaf per sub-stage, a column id may be either a
// stage id (single-leaf stage) or a sub-stage id. Returns -1 if not found.
function columnLeafIndex(stages: Stage[], columnId: string): number {
  let leaf = 0;
  for (const s of stages || []) {
    const subs = s.subStages || [];
    if (s.id === columnId) return leaf;
    if (subs.length) {
      for (const ss of subs) {
        if (ss.id === columnId) return leaf;
        leaf++;
      }
    } else {
      leaf++;
    }
  }
  return -1;
}

function locateColumn(
  stages: Stage[],
  columnId: string,
): { stageIdx: number; subIdx: number | null; leafIdx: number } | null {
  let leafIdx = 0;
  for (let stageIdx = 0; stageIdx < (stages || []).length; stageIdx++) {
    const s = stages[stageIdx];
    const subs = s.subStages || [];
    if (s.id === columnId && !subs.length) return { stageIdx, subIdx: null, leafIdx };
    if (subs.length) {
      for (let subIdx = 0; subIdx < subs.length; subIdx++) {
        if (subs[subIdx].id === columnId) return { stageIdx, subIdx, leafIdx };
        leafIdx++;
      }
    } else {
      leafIdx++;
    }
  }
  return null;
}

// Apply a per-row cells transform to every row of every sub-journey of a journey.
function mapJourneyRows(j: Journey, fn: (cells: Cell[], row: Row) => Cell[]): Journey {
  return {
    ...j,
    subJourneys: (j.subJourneys || []).map((sj) => ({
      ...sj,
      rows: (sj.rows || []).map((r) => ({ ...r, cells: fn(r.cells || [], r) })),
    })),
  };
}

function replaceJourney(journeys: Journey[], idx: number, nj: Journey): Journey[] {
  const next = journeys.slice();
  next[idx] = nj;
  return next;
}

// Insert `item` after the entity with id `afterId` (or at the front when null).
function insertAfter<T extends { id?: string }>(arr: T[], afterId: string | null, item: T): T[] | null {
  if (afterId == null) return [item, ...arr];
  const at = arr.findIndex((x) => x.id === afterId);
  if (at < 0) return null;
  const next = arr.slice();
  next.splice(at + 1, 0, item);
  return next;
}
// Move the entity with id `id` to just after `afterId` (or to the front when null).
function moveAfter<T extends { id?: string }>(arr: T[], id: string, afterId: string | null): T[] | null {
  const from = arr.findIndex((x) => x.id === id);
  if (from < 0) return null;
  const without = arr.slice();
  const [moved] = without.splice(from, 1);
  if (afterId == null) return [moved, ...without];
  const at = without.findIndex((x) => x.id === afterId);
  if (at < 0) return null;
  without.splice(at + 1, 0, moved);
  return without;
}

// ── the op applier ───────────────────────────────────────────────────────────
// Returns the next journeys array, or null to signal "could not apply → resync".
export function applyOp(journeys: unknown[], op: Op): unknown[] | null {
  if (!op || typeof op.t !== "string") return null;
  const J = (Array.isArray(journeys) ? journeys : []) as Journey[];
  // mintId is only used for non-id-carrying paths (divider/normalize padding).
  const mintId = rid;

  switch (op.t) {
    // ── content (per-cell LWW handled by caller via ts; here just set fields) ──
    case "cell.set": {
      const cellId = op.cellId as string;
      const fields = (op.fields || {}) as Partial<Cell>;
      if (!cellId) return null;
      let found = false;
      const next = J.map((j) => ({
        ...j,
        subJourneys: (j.subJourneys || []).map((sj) => ({
          ...sj,
          rows: (sj.rows || []).map((r) => ({
            ...r,
            cells: (r.cells || []).map((c) => {
              if (c.id !== cellId) return c;
              found = true;
              const nc: Cell = { ...c };
              if ("html" in fields) nc.html = fields.html;
              if ("tags" in fields) nc.tags = fields.tags;
              if ("mode" in fields) nc.mode = fields.mode;
              if ("align" in fields) nc.align = fields.align;
              return nc;
            }),
          })),
        })),
      }));
      return found ? next : null;
    }

    // ── rows (within a sub-journey) ──
    case "row.insert": {
      const sjId = op.subJourneyId as string;
      const afterRowId = (op.afterRowId ?? null) as string | null;
      const row = op.row as Row;
      if (!sjId || !row) return null;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const loc = findSubJourney(J[jIdx], sjId);
        if (!loc) continue;
        // Normalize the incoming row's cells to the journey's column count so a
        // peer that built it against a stale tree still converges.
        const total = totalLeaves(J[jIdx].stages || []);
        let cells = normalizeRowCells(row.cells || [], total, mintId);
        if (row.rowType === DIVIDER_TYPE) cells = collapseDivider(cells, total, mintId);
        const newRow: Row = { ...row, cells };
        const rows = insertAfter(loc.sj.rows || [], afterRowId, newRow);
        if (!rows) return null;
        const nsj: SubJourney = { ...loc.sj, rows };
        const nsjs = (J[jIdx].subJourneys || []).slice();
        nsjs[loc.idx] = nsj;
        return replaceJourney(J, jIdx, { ...J[jIdx], subJourneys: nsjs });
      }
      return null;
    }
    case "row.delete": {
      const rowId = op.rowId as string;
      const loc = locateRow(J, rowId);
      if (!loc) return null;
      const j = J[loc.jIdx];
      const nsjs = (j.subJourneys || []).slice();
      const sj = nsjs[loc.sjIdx];
      const rows = (sj.rows || []).filter((r) => r.id !== rowId);
      nsjs[loc.sjIdx] = { ...sj, rows };
      return replaceJourney(J, loc.jIdx, { ...j, subJourneys: nsjs });
    }
    case "row.move": {
      const rowId = op.rowId as string;
      const afterRowId = (op.afterRowId ?? null) as string | null;
      const loc = locateRow(J, rowId);
      if (!loc) return null;
      const j = J[loc.jIdx];
      const nsjs = (j.subJourneys || []).slice();
      const sj = nsjs[loc.sjIdx];
      const rows = moveAfter(sj.rows || [], rowId, afterRowId);
      if (!rows) return null;
      nsjs[loc.sjIdx] = { ...sj, rows };
      return replaceJourney(J, loc.jIdx, { ...j, subJourneys: nsjs });
    }
    case "row.setType": {
      const rowId = op.rowId as string;
      const rowType = op.rowType as string;
      const loc = locateRow(J, rowId);
      if (!loc) return null;
      const j = J[loc.jIdx];
      const total = totalLeaves(j.stages || []);
      const nsjs = (j.subJourneys || []).slice();
      const sj = nsjs[loc.sjIdx];
      const rows = (sj.rows || []).slice();
      const cur = rows[loc.rowIdx];
      const wasDivider = cur.rowType === DIVIDER_TYPE;
      const willDivider = rowType === DIVIDER_TYPE;
      let cells = cur.cells || [];
      if (willDivider && !wasDivider) cells = collapseDivider(cells, total, mintId);
      else if (!willDivider && wasDivider) cells = expandDivider(cells, total, mintId);
      rows[loc.rowIdx] = { ...cur, rowType, cells };
      nsjs[loc.sjIdx] = { ...sj, rows };
      return replaceJourney(J, loc.jIdx, { ...j, subJourneys: nsjs });
    }
    case "row.setLabel": {
      const rowId = op.rowId as string;
      const loc = locateRow(J, rowId);
      if (!loc) return null;
      const j = J[loc.jIdx];
      const nsjs = (j.subJourneys || []).slice();
      const sj = nsjs[loc.sjIdx];
      const rows = (sj.rows || []).slice();
      rows[loc.rowIdx] = { ...rows[loc.rowIdx], laneLabel: op.label as string };
      nsjs[loc.sjIdx] = { ...sj, rows };
      return replaceJourney(J, loc.jIdx, { ...j, subJourneys: nsjs });
    }
    case "row.setColor": {
      const rowId = op.rowId as string;
      const loc = locateRow(J, rowId);
      if (!loc) return null;
      const j = J[loc.jIdx];
      const nsjs = (j.subJourneys || []).slice();
      const sj = nsjs[loc.sjIdx];
      const rows = (sj.rows || []).slice();
      const color = op.color as string | undefined;
      rows[loc.rowIdx] = { ...rows[loc.rowIdx], customColor: color || undefined };
      nsjs[loc.sjIdx] = { ...sj, rows };
      return replaceJourney(J, loc.jIdx, { ...j, subJourneys: nsjs });
    }

    // ── columns (journey-wide; every row gains/loses/reorders one cell) ──
    case "column.insert": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).slice();
      const newColumnId = (op.columnId || op.stageId) as string;
      if (!newColumnId) return null;
      // The new leaf index = right after the named afterColumnId, or 0 when null.
      const afterColumnId = (op.afterColumnId ?? null) as string | null;
      let leafIdx: number;
      let insertStageIdx: number;
      if (afterColumnId == null) {
        leafIdx = 0;
        insertStageIdx = 0;
      }
      else {
        const loc = locateColumn(stages, afterColumnId);
        if (!loc) return null;
        leafIdx = loc.leafIdx + 1;
        insertStageIdx = loc.stageIdx + 1;
      }
      const stage = (op.stage as Stage) || { id: newColumnId, title: "New Stage", subStages: [] };
      stages.splice(insertStageIdx, 0, stage);
      // Per-row minted cell ids supplied by the client: { rowId: cellId }.
      const cellIds = (op.cellIds || {}) as Record<string, string>;
      const nj = mapJourneyRows({ ...j, stages }, (cells, row) => {
        if (row.rowType === DIVIDER_TYPE) {
          // A divider is a single full-width cell; widening keeps it one cell.
          const total = totalLeaves(stages);
          return collapseDivider(cells, total, mintId);
        }
        return insertLeafIntoRow(cells, leafIdx, row.id ? cellIds[row.id] : undefined);
      });
      return replaceJourney(J, jIdx, nj);
    }
    case "column.delete": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).map((s) => ({ ...s, subStages: (s.subStages || []).slice() }));
      const loc = locateColumn(stages, op.columnId as string);
      if (!loc) return null;
      const leafIdx = loc.leafIdx;
      if (loc.subIdx == null) stages.splice(loc.stageIdx, 1);
      else stages[loc.stageIdx].subStages!.splice(loc.subIdx, 1);
      const newTotal = Math.max(totalLeaves(stages), 0);
      const nj = mapJourneyRows({ ...j, stages }, (cells, row) => {
        if (row.rowType === DIVIDER_TYPE) return collapseDivider(cells, Math.max(newTotal, 1), mintId);
        return removeLeafFromRow(cells, leafIdx);
      });
      return replaceJourney(J, jIdx, nj);
    }
    case "column.move": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).map((s) => ({ ...s, subStages: (s.subStages || []).slice() }));
      const loc = locateColumn(stages, op.columnId as string);
      if (!loc) return null;
      const from = loc.leafIdx;
      const afterColumnId = (op.afterColumnId ?? null) as string | null;
      let to: number;
      if (afterColumnId == null) to = 0;
      else {
        const afterLoc = locateColumn(stages, afterColumnId);
        if (!afterLoc) return null;
        to = afterLoc.leafIdx + 1;
      }
      if (loc.subIdx == null) {
        const afterStageId = afterColumnId == null ? null : stages[locateColumn(stages, afterColumnId)!.stageIdx].id || null;
        const movedStages = moveAfter(stages, op.columnId as string, afterStageId);
        if (!movedStages) return null;
        stages.splice(0, stages.length, ...movedStages);
      } else if (afterColumnId == null || locateColumn(stages, afterColumnId)?.stageIdx === loc.stageIdx) {
        const subs = stages[loc.stageIdx].subStages!;
        const movedSubs = moveAfter(subs, op.columnId as string, afterColumnId);
        if (!movedSubs) return null;
        stages[loc.stageIdx] = { ...stages[loc.stageIdx], subStages: movedSubs };
      }
      const nj = {
        ...j,
        stages,
        subJourneys: (j.subJourneys || []).map((sj) => ({
          ...sj,
          rows: (sj.rows || []).map((r) => moveLeafRangeInRow(r, from, 1, to, mintId)),
        })),
      };
      return replaceJourney(J, jIdx, nj);
    }

    // ── stages (top-level columns / column-header tree) ──
    case "stage.insert": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).slice();
      const stage = op.stage as Stage;
      if (!stage) return null;
      const afterStageId = (op.afterStageId ?? null) as string | null;
      // Insert the stage header.
      const inserted = insertAfter(stages, afterStageId, stage);
      if (!inserted) return null;
      // Compute the global leaf index where this stage's columns begin.
      const insertIdx = afterStageId == null ? 0 : inserted.findIndex((s) => s.id === stage.id);
      const leafIdx = leafStart(inserted, insertIdx);
      const addLeaves = leafCount(stage);
      const cellIds = (op.cellIds || {}) as Record<string, string[]>; // rowId -> [cellId,...]
      const nj = mapJourneyRows({ ...j, stages: inserted }, (cells, row) => {
        if (row.rowType === DIVIDER_TYPE) {
          return collapseDivider(cells, totalLeaves(inserted), mintId);
        }
        let c = cells;
        const ids = row.id ? cellIds[row.id] : undefined;
        for (let k = 0; k < addLeaves; k++) {
          c = insertLeafIntoRow(c, leafIdx + k, ids ? ids[k] : undefined);
        }
        return c;
      });
      return replaceJourney(J, jIdx, nj);
    }
    case "stage.delete": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).slice();
      const sIdx = stageIndexById(stages, op.stageId as string);
      if (sIdx < 0) return null;
      const start = leafStart(stages, sIdx);
      const cnt = leafCount(stages[sIdx]);
      stages.splice(sIdx, 1);
      const newTotal = Math.max(totalLeaves(stages), 1);
      const nj = mapJourneyRows({ ...j, stages }, (cells, row) => {
        if (row.rowType === DIVIDER_TYPE) return collapseDivider(cells, newTotal, mintId);
        let c = cells;
        for (let k = 0; k < cnt; k++) c = removeLeafFromRow(c, start);
        return c;
      });
      return replaceJourney(J, jIdx, nj);
    }
    case "stage.move": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).slice();
      const fromIdx = stageIndexById(stages, op.stageId as string);
      if (fromIdx < 0) return null;
      const afterStageId = (op.afterStageId ?? null) as string | null;
      // Resolve the destination stage index (insert AFTER afterStageId).
      let toIdx: number;
      if (afterStageId == null) toIdx = 0;
      else {
        const ai = stageIndexById(stages, afterStageId);
        if (ai < 0) return null;
        toIdx = ai + 1; // moveArrayRange's `to` is the pre-removal insertion index.
      }
      const start = leafStart(stages, fromIdx);
      const cnt = leafCount(stages[fromIdx]);
      const target = leafStart(stages, toIdx);
      const movedStages = moveArrayRange(stages, fromIdx, 1, toIdx);
      if (movedStages === stages) return replaceJourney(J, jIdx, { ...j }); // no-op
      const nj = {
        ...j,
        stages: movedStages,
        subJourneys: (j.subJourneys || []).map((sj) => ({
          ...sj,
          rows: (sj.rows || []).map((r) => moveLeafRangeInRow(r, start, cnt, target, mintId)),
        })),
      };
      return replaceJourney(J, jIdx, nj);
    }
    case "stage.setLabel": {
      // Rename a stage title by id (search the journey containing it).
      const stageId = op.stageId as string;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const stages = (J[jIdx].stages || []).slice();
        const sIdx = stageIndexById(stages, stageId);
        if (sIdx < 0) continue;
        stages[sIdx] = { ...stages[sIdx], title: op.label as string };
        return replaceJourney(J, jIdx, { ...J[jIdx], stages });
      }
      return null;
    }
    case "stage.setNum": {
      const stageId = op.stageId as string;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const stages = (J[jIdx].stages || []).slice();
        const sIdx = stageIndexById(stages, stageId);
        if (sIdx < 0) continue;
        stages[sIdx] = { ...stages[sIdx], num: op.num as unknown };
        return replaceJourney(J, jIdx, { ...J[jIdx], stages });
      }
      return null;
    }

    // ── sub-stages (under a stageId; each is a column leaf) ──
    case "substage.insert": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).map((s) => ({ ...s, subStages: (s.subStages || []).slice() }));
      const sIdx = stageIndexById(stages, op.stageId as string);
      if (sIdx < 0) return null;
      const subStage = op.subStage as Stage;
      if (!subStage) return null;
      const before = stages[sIdx].subStages!.length;
      const afterSubStageId = (op.afterSubStageId ?? null) as string | null;
      const subs = insertAfter(stages[sIdx].subStages!, afterSubStageId, subStage);
      if (!subs) return null;
      stages[sIdx] = { ...stages[sIdx], subStages: subs };
      const oldL = Math.max(before, 1);
      const newL = Math.max(before + 1, 1);
      if (newL <= oldL) return replaceJourney(J, jIdx, { ...j, stages });
      // The new leaf lands at the inserted sub-stage's position within this stage.
      const localIdx = subs.findIndex((s) => s.id === subStage.id);
      const gi = leafStart(stages, sIdx) + localIdx;
      const cellIds = (op.cellIds || {}) as Record<string, string>;
      const nj = mapJourneyRows({ ...j, stages }, (cells, row) => {
        if (row.rowType === DIVIDER_TYPE) return collapseDivider(cells, totalLeaves(stages), mintId);
        return insertLeafIntoRow(cells, gi, row.id ? cellIds[row.id] : undefined);
      });
      return replaceJourney(J, jIdx, nj);
    }
    case "substage.delete": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).map((s) => ({ ...s, subStages: (s.subStages || []).slice() }));
      const sIdx = stageIndexById(stages, op.stageId as string);
      if (sIdx < 0) return null;
      const subs = stages[sIdx].subStages!;
      const subIdx = subs.findIndex((s) => s.id === op.subStageId);
      if (subIdx < 0) return null;
      const before = subs.length;
      subs.splice(subIdx, 1);
      const oldL = Math.max(before, 1);
      const newL = Math.max(before - 1, 1);
      if (newL >= oldL) return replaceJourney(J, jIdx, { ...j, stages });
      const gi = leafStart(stages, sIdx) + Math.min(subIdx, oldL - 1);
      const nj = mapJourneyRows({ ...j, stages }, (cells, row) => {
        if (row.rowType === DIVIDER_TYPE) return collapseDivider(cells, Math.max(totalLeaves(stages), 1), mintId);
        return removeLeafFromRow(cells, gi);
      });
      return replaceJourney(J, jIdx, nj);
    }
    case "substage.move": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const stages = (j.stages || []).map((s) => ({ ...s, subStages: (s.subStages || []).slice() }));
      const sIdx = stageIndexById(stages, op.stageId as string);
      if (sIdx < 0) return null;
      const subs = stages[sIdx].subStages!;
      const fromIdx = subs.findIndex((s) => s.id === op.subStageId);
      if (fromIdx < 0 || subs.length <= 1) return null;
      const afterSubStageId = (op.afterSubStageId ?? null) as string | null;
      let toIdx: number;
      if (afterSubStageId == null) toIdx = 0;
      else {
        const ai = subs.findIndex((s) => s.id === afterSubStageId);
        if (ai < 0) return null;
        toIdx = ai + 1; // moveArrayRange's `to` is the pre-removal insertion index.
      }
      const start = leafStart(stages, sIdx);
      const fromLeaf = start + fromIdx;
      const toLeaf = start + toIdx;
      const movedSubs = moveArrayRange(subs, fromIdx, 1, toIdx);
      if (movedSubs === subs) return replaceJourney(J, jIdx, { ...j });
      stages[sIdx] = { ...stages[sIdx], subStages: movedSubs };
      const nj = {
        ...j,
        stages,
        subJourneys: (j.subJourneys || []).map((sj) => ({
          ...sj,
          rows: (sj.rows || []).map((r) => moveLeafRangeInRow(r, fromLeaf, 1, toLeaf, mintId)),
        })),
      };
      return replaceJourney(J, jIdx, nj);
    }
    case "substage.setLabel": {
      const stageId = op.stageId as string;
      const subStageId = op.subStageId as string;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const stages = (J[jIdx].stages || []).map((s) => ({ ...s, subStages: (s.subStages || []).slice() }));
        const sIdx = stageIndexById(stages, stageId);
        if (sIdx < 0) continue;
        const subs = stages[sIdx].subStages!;
        const subIdx = subs.findIndex((s) => s.id === subStageId);
        if (subIdx < 0) return null;
        subs[subIdx] = { ...subs[subIdx], title: op.label as string };
        return replaceJourney(J, jIdx, { ...J[jIdx], stages });
      }
      return null;
    }

    // ── sub-journeys (lanes / row groups) ──
    case "subjourney.insert": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      const { idx: jIdx, j } = found;
      const subJourney = op.subJourney as SubJourney;
      if (!subJourney) return null;
      const afterSubJourneyId = (op.afterSubJourneyId ?? null) as string | null;
      const sjs = insertAfter(j.subJourneys || [], afterSubJourneyId, subJourney);
      if (!sjs) return null;
      return replaceJourney(J, jIdx, { ...j, subJourneys: sjs });
    }
    case "subjourney.delete": {
      const sjId = op.subJourneyId as string;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const sjs = J[jIdx].subJourneys || [];
        if (!sjs.some((sj) => sj.id === sjId)) continue;
        return replaceJourney(J, jIdx, { ...J[jIdx], subJourneys: sjs.filter((sj) => sj.id !== sjId) });
      }
      return null;
    }
    case "subjourney.move": {
      const sjId = op.subJourneyId as string;
      const afterSubJourneyId = (op.afterSubJourneyId ?? null) as string | null;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const sjs = J[jIdx].subJourneys || [];
        if (!sjs.some((sj) => sj.id === sjId)) continue;
        const moved = moveAfter(sjs, sjId, afterSubJourneyId);
        if (!moved) return null;
        return replaceJourney(J, jIdx, { ...J[jIdx], subJourneys: moved });
      }
      return null;
    }
    case "subjourney.setLabel": {
      const sjId = op.subJourneyId as string;
      for (let jIdx = 0; jIdx < J.length; jIdx++) {
        const sjs = (J[jIdx].subJourneys || []).slice();
        const sjIdx = sjs.findIndex((sj) => sj.id === sjId);
        if (sjIdx < 0) continue;
        sjs[sjIdx] = { ...sjs[sjIdx], label: op.label as string };
        return replaceJourney(J, jIdx, { ...J[jIdx], subJourneys: sjs });
      }
      return null;
    }

    // ── journeys (tabs) ──
    case "journey.insert": {
      const journey = op.journey as Journey;
      if (!journey) return null;
      const afterJourneyId = (op.afterJourneyId ?? null) as string | null;
      const next = insertAfter(J, afterJourneyId, journey);
      return next;
    }
    case "journey.delete": {
      const journeyId = op.journeyId as string;
      if (!J.some((j) => j.id === journeyId)) return null;
      return J.filter((j) => j.id !== journeyId);
    }
    case "journey.move": {
      const journeyId = op.journeyId as string;
      const afterJourneyId = (op.afterJourneyId ?? null) as string | null;
      return moveAfter(J, journeyId, afterJourneyId);
    }
    case "journey.rename": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      return replaceJourney(J, found.idx, { ...found.j, title: op.name as string });
    }
    case "journey.setStageLabel": {
      const found = findJourney(J, op.journeyId as string);
      if (!found) return null;
      return replaceJourney(J, found.idx, { ...found.j, stageLabel: op.label as string });
    }

    default:
      return null; // unknown op → caller resyncs
  }
}

// Op classification: content ops are commutative & not version-gated; everything
// else is structural and serialized through the global version.
export function isContentOp(t: string): boolean {
  return t === "cell.set";
}
