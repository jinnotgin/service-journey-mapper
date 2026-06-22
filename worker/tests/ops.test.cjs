const assert = require("node:assert/strict");
const test = require("node:test");

const { applyOp, isContentOp } = require("../.test-build/ops.js");

const cell = (id, html = "") => ({ id, mode: "text", html, align: "left" });
const row = (id, cells, rowType = "row-operator") => ({ id, rowType, laneLabel: id, cells });
const width = (r) => (r.cells || []).reduce((n, c) => n + (c.colspan || 1), 0);

function fixture() {
  return [{
    id: "j1",
    title: "Journey",
    stageLabel: "Stages",
    stages: [
      { id: "s1", num: 1, title: "One", subStages: [] },
      { id: "s2", num: 2, title: "Two", subStages: [] },
      { id: "s3", num: 3, title: "Three", subStages: [] },
    ],
    subJourneys: [{
      id: "sj1",
      title: "Main",
      label: "Main",
      rows: [
        row("r1", [cell("c11"), cell("c12"), cell("c13")]),
        row("r2", [cell("c21"), cell("c22"), cell("c23")]),
      ],
    }],
  }];
}

test("classifies cell.set as the only content op", () => {
  assert.equal(isContentOp("cell.set"), true);
  assert.equal(isContentOp("row.insert"), false);
});

test("cell.set patches only the targeted cell fields", () => {
  const next = applyOp(fixture(), {
    t: "cell.set",
    cellId: "c22",
    fields: { html: "patched", mode: "boxes", align: "center" },
  });

  assert.equal(next[0].subJourneys[0].rows[1].cells[1].html, "patched");
  assert.equal(next[0].subJourneys[0].rows[1].cells[1].mode, "boxes");
  assert.equal(next[0].subJourneys[0].rows[1].cells[1].align, "center");
  assert.equal(next[0].subJourneys[0].rows[0].cells[0].html, "");
});

test("row.setType collapses and expands divider cells to the journey width", () => {
  const divided = applyOp(fixture(), { t: "row.setType", rowId: "r1", rowType: "row-divider" });
  assert.equal(divided[0].subJourneys[0].rows[0].cells.length, 1);
  assert.equal(divided[0].subJourneys[0].rows[0].cells[0].colspan, 3);

  const expanded = applyOp(divided, { t: "row.setType", rowId: "r1", rowType: "row-operator" });
  assert.equal(width(expanded[0].subJourneys[0].rows[0]), 3);
  assert.equal(expanded[0].subJourneys[0].rows[0].cells.length, 3);
});

test("column.insert adds a header leaf and one deterministic cell per row", () => {
  const next = applyOp(fixture(), {
    t: "column.insert",
    journeyId: "j1",
    stageId: "s4",
    afterColumnId: "s1",
    cellIds: { r1: "r1s4", r2: "r2s4" },
  });

  assert.deepEqual(next[0].stages.map((s) => s.id), ["s1", "s4", "s2", "s3"]);
  assert.deepEqual(next[0].subJourneys[0].rows.map(width), [4, 4]);
  assert.equal(next[0].subJourneys[0].rows[0].cells[1].id, "r1s4");
  assert.equal(next[0].subJourneys[0].rows[1].cells[1].id, "r2s4");
});

test("column.move reorders both header leaves and row cells", () => {
  const inserted = applyOp(fixture(), {
    t: "column.insert",
    journeyId: "j1",
    stageId: "s4",
    afterColumnId: "s1",
    cellIds: { r1: "r1s4", r2: "r2s4" },
  });
  const moved = applyOp(inserted, {
    t: "column.move",
    journeyId: "j1",
    columnId: "s4",
    afterColumnId: "s3",
  });

  assert.deepEqual(moved[0].stages.map((s) => s.id), ["s1", "s2", "s3", "s4"]);
  assert.equal(moved[0].subJourneys[0].rows[0].cells[3].id, "r1s4");
  assert.equal(moved[0].subJourneys[0].rows[1].cells[3].id, "r2s4");
});

test("column.delete removes the header leaf and matching cell from every row", () => {
  const inserted = applyOp(fixture(), {
    t: "column.insert",
    journeyId: "j1",
    stageId: "s4",
    afterColumnId: "s1",
    cellIds: { r1: "r1s4", r2: "r2s4" },
  });
  const next = applyOp(inserted, { t: "column.delete", journeyId: "j1", columnId: "s4" });

  assert.deepEqual(next[0].stages.map((s) => s.id), ["s1", "s2", "s3"]);
  assert.deepEqual(next[0].subJourneys[0].rows.map(width), [3, 3]);
  assert.equal(next[0].subJourneys[0].rows[0].cells.some((c) => c.id === "r1s4"), false);
});

test("stage.move carries its leaf range through every row", () => {
  const doc = fixture();
  doc[0].stages[0] = {
    id: "s1",
    num: 1,
    title: "One",
    subStages: [{ id: "ss1", title: "A" }, { id: "ss2", title: "B" }],
  };
  doc[0].subJourneys[0].rows[0].cells = [cell("ss1r1"), cell("ss2r1"), cell("s2r1"), cell("s3r1")];
  doc[0].subJourneys[0].rows[1].cells = [cell("ss1r2"), cell("ss2r2"), cell("s2r2"), cell("s3r2")];

  const next = applyOp(doc, { t: "stage.move", journeyId: "j1", stageId: "s1", afterStageId: "s3" });

  assert.deepEqual(next[0].stages.map((s) => s.id), ["s2", "s3", "s1"]);
  assert.deepEqual(next[0].subJourneys[0].rows[0].cells.map((c) => c.id), ["s2r1", "s3r1", "ss1r1", "ss2r1"]);
  assert.deepEqual(next[0].subJourneys[0].rows[1].cells.map((c) => c.id), ["s2r2", "s3r2", "ss1r2", "ss2r2"]);
});

test("unknown ids return null so callers can doc.reject resync", () => {
  assert.equal(applyOp(fixture(), { t: "row.delete", rowId: "missing" }), null);
  assert.equal(applyOp(fixture(), { t: "cell.set", cellId: "missing", fields: { html: "x" } }), null);
});
