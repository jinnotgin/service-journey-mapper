# Plan: Make The Service Map Feel Less Like Excel

Analysis-only design plan for the Lanescape service journey mapper.

## Context

The current interface is a serious service blueprint surface: good for reading,
exporting, and reviewing a filled map. The risk is that edit mode feels like a
spreadsheet because every concept is represented as a table cell with similar
weight: stages, steps, lane labels, content, empty space, and selection all read
through borders.

The competitor feels friendlier because it frames the map as a set of editable
objects on a canvas: stages, steps, lanes, cards, tags, and divider lines. We
should borrow that object model, not the visual styling wholesale.

Register: product UI. Design should serve repeated mapping work, workshops, and
editing sessions. The right mood is calm, structured, and tactile.

Scene sentence: a service designer or policy team is editing a long journey map
on a laptop or meeting-room display in normal office light, switching between
capturing rough notes and preparing a map that can be shared with stakeholders.

Theme: light. The map is a document-like workspace that needs print/export trust
and workshop readability.

Color strategy: restrained neutrals with semantic lane color. Accent color should
mark selection, focus, and primary actions only. Lane colors should orient the
reader without turning every cell into a colored block.

## Design Goal

Make the same matrix feel like a designed mapping workspace instead of a sheet.

The core shift:

- From table cells to editable objects.
- From grid dominance to spatial grouping.
- From black selection boxes to calm editing affordances.
- From "all rows are equal" to lane identity and service blueprint semantics.
- From dense by default to mode-aware density.

## What To Keep

- The current map structure. It is more complete and exportable than the
  competitor's blank canvas.
- The top app bar in a light document style. Do not copy the competitor's dark
  header shell.
- OKLCH token direction and restrained palette.
- Stage numbering, party pills, row types, edit/view mode, tags, bullets, boxes,
  alignment controls, and collaboration lock states.
- The current export/review seriousness. This is a strength.

## What Not To Copy

- Do not copy the competitor's full pastel block aesthetic. It may feel friendly
  in an empty demo but can become toy-like with real service content.
- Do not use thick colored side stripes on rows, cards, or alerts. Use full-row
  tint, icons, hairline borders, label chips, or small status markers instead.
- Do not make every cell into a raised card. Cards should appear only for actual
  notes or grouped content inside a cell.
- Do not make the app shell dark just because the competitor does. It would
  fight the document/workshop character of this product.

## Concrete Changes

### 1. Rebalance The Grid

Problem:
The current table borders have similar weight everywhere. This makes the map read
as a spreadsheet before it reads as a journey.

Plan:

- Reduce vertical and horizontal grid line contrast for body cells.
- Keep stronger boundaries only at conceptual breaks:
  - left lane rail
  - stage boundaries
  - sub-stage header boundary
  - visibility divider
  - selected or focused cell
- Use very light body grid lines, for example `oklch(91% .004 70 / .65)`.
- Use stage boundaries as slightly stronger vertical separators.
- Give the whole blueprint a quiet page surface, then let lanes and objects sit
  on top of it.

Acceptance:
At 75 percent zoom, users should see lane groups and stages before seeing every
individual cell border.

### 2. Turn Stage And Step Headers Into Objects

Problem:
Stage and sub-stage headers currently look like table headings. They do not
strongly communicate "drag, rename, add, reorder."

Plan:

- Render stage headers as compact header blocks inside the header cell:
  - stage number in a small solid circle or capsule
  - stage title as the primary label
  - drag handle visible on hover/focus
  - menu button visible on hover/focus
- Render sub-stage headers as smaller "step chips" nested under their stage.
- Preserve table alignment, but visually separate the header object from the cell.
- Make editable header hover states use a soft background and icon reveal, not
  raw contenteditable focus only.

Do:

- Stage object: `1 Attraction, Recruitment & Onboarding`
- Step object: `Explore Profession`
- Hover: reveal drag handle and menu.
- Focus: 2px soft ring in the app accent.

Do not:

- Use oversized pastel rounded rectangles copied from the competitor.
- Let header chips resize the column on hover.

Acceptance:
Before editing content, a new user should correctly infer that stages and steps
can be renamed, reordered, and managed.

### 3. Give Lanes Stronger Identity

Problem:
The row label column is readable, but the map still feels like a list of rows.
Friendly blueprint tools make each lane feel like a named workstream.

Plan:

- Add small lane icons to standard row types:
  - parties: users or group
  - educator/customer actions: person
  - frontstage human: user-round
  - frontstage system: monitor
  - backstage human: users
  - backstage system: settings
  - support: layers
  - pain: alert-triangle
  - verbatim: quote
  - emotion: smile
  - suggestions: lightbulb
- Keep icons small, 14 to 16px, same stroke family.
- Make lane labels less spreadsheet-like:
  - icon row
  - uppercase secondary family label when needed
  - human-readable main label
- Use row tint across the lane and body surface, but with body content near-white.
- Avoid thick side accents. If a lane needs stronger identity, use icon color,
  label color, and a faint full-row tint.

Acceptance:
Users should be able to scan down the left side and understand the service
blueprint layers without reading every full label.

### 4. Make The Line Of Visibility A Service Blueprint Moment

Problem:
The current divider row is functional but heavy. It reads like another table row
instead of a conceptual boundary.

Plan:

- Replace the dark divider bar with a quieter horizontal rule across the map.
- Use a dashed or dotted line across body columns.
- Put the label "Line of visibility" in the left lane rail with subtle uppercase
  type.
- Keep the divider sticky alignment and stage width behavior.
- Allow divider rows to remain editable if needed, but make their default visual
  a boundary, not a filled band.

Acceptance:
The divider should explain the blueprint model at a glance without interrupting
the user's reading flow.

### 5. Treat Cell Content As Notes Inside A Workspace

Problem:
Body cells currently contain text directly in the table. This reinforces the
spreadsheet feeling and makes empty cells feel like blank spreadsheet cells.

Plan:

- In view mode, keep content clean and document-like.
- In edit mode, render non-empty cells as note surfaces inside the cell:
  - subtle inset panel or note block
  - 6 to 8px radius
  - light border and almost-white fill
  - no nested card effect if the cell already has boxes mode
- Empty cells should not show a hard box by default.
- On hover in edit mode, empty cells can show a low-contrast "Add note" affordance
  or a centered plus button.
- Maintain current cell modes:
  - text: plain note
  - bullets: note with bullets
  - boxes: multiple compact items
  - tags: chip collection

Acceptance:
The map should still look like a blueprint, but the editable content should feel
like notes placed in lanes, not text typed into spreadsheet cells.

### 6. Soften Selection And Focus

Problem:
The current selected empty cell has a black rectangular outline that dominates the
screen and feels punitive.

Plan:

- Separate selection from active editing:
  - selected cell: soft inset ring, low contrast
  - active editing: stronger accent ring plus toolbar
  - peer locked: distinct collaborator outline and badge
- Use accent color, not black, for focus.
- Add a faint selected background fill instead of relying only on the outline.
- Keep the toolbar anchored, but make the selected cell visual less aggressive.

Suggested state ladder:

- Hover editable cell: faint background plus 1px inset border.
- Selected cell: 2px soft accent ring and subtle fill.
- Focused contenteditable cell: 2px stronger accent ring, no layout shift.
- Peer locked cell: collaborator color ring, badge, read-only cursor.

Acceptance:
A selected blank cell should look ready for input, not like a spreadsheet range
selection or validation error.

### 7. Make The Format Toolbar Feel Like A Context Tool

Problem:
The current floating toolbar is useful but visually heavy. It adds to the sense
that the user is formatting spreadsheet text.

Plan:

- Keep the toolbar because it is practical.
- Make it smaller and more contextual:
  - icon-first buttons for text, bullets, boxes, tags
  - visible labels only where ambiguity is high
  - grouped controls with separators
  - lighter neutral surface than the current dark bar, or a dark bar with reduced
    contrast and less mass
- Align toolbar to the selected cell with collision handling so it does not cover
  adjacent content too aggressively.
- Consider showing only mode controls first, with text formatting expanding when
  a text cell is focused.

Acceptance:
The toolbar should feel like a craft tool for notes, not a spreadsheet formatting
ribbon.

### 8. Introduce Density Modes

Problem:
The current map is optimized for dense review. Editing a map from scratch benefits
from more whitespace and clearer affordances.

Plan:

- Add two display densities:
  - Comfortable: default in edit mode, larger row min-height, more cell padding,
    visible empty-cell affordances.
  - Compact: default in view/export mode, closer to today's density.
- Store density per browser or per project.
- Keep export output compact and document-like.
- Do not use fluid font scaling. Use fixed product UI type sizes.

Acceptance:
First-time editing should feel approachable. Reviewing a completed map should
still feel efficient.

### 9. Improve Empty And Starter States

Problem:
Blank maps need scaffolding. Competitor screenshots are friendlier partly because
their empty map shows the expected shape before content exists.

Plan:

- For a new blank journey, show a scaffolded first stage and first step with
  empty lanes already visible.
- Use inline empty prompts by lane:
  - Parties: "Add involved parties"
  - Actions: "Describe what the person does"
  - Frontstage human: "Add staff or partner action"
  - Frontstage system: "Add visible system touchpoint"
  - Pain: "Add friction or risk"
- Prompts should appear only on hover or in empty selected cells to avoid noisy
  exports.
- Provide one "Add first step" or "Add next stage" affordance near the headers.

Acceptance:
A user opening a blank map should know where to begin without reading
instructions.

### 10. Preserve Export And Review Polish

Problem:
Making edit mode friendlier can accidentally make the final map feel less formal.

Plan:

- Treat edit and view/export as related but distinct presentations.
- Edit mode can show handles, add buttons, selected rings, prompts, and note
  surfaces.
- View mode should hide most affordances, reduce note chrome, and emphasize the
  actual service story.
- Export should use the view-mode visual language with high legibility and no
  empty prompts.

Acceptance:
The product should feel friendly while building and credible when shared.

## Phased Implementation Plan

### Phase 1: Visual Hierarchy Pass

Scope:

- Soften grid lines.
- Strengthen conceptual boundaries.
- Redesign selected, hover, and focused cell states.
- Make the line of visibility quieter and more semantic.

Why first:
This removes the strongest Excel cues with limited data-model risk.

Risk:
Too little contrast can hurt navigation in large maps. Verify at normal zoom,
75 percent zoom, and on export.

### Phase 2: Header And Lane Object Pass

Scope:

- Make stage headers object-like.
- Make sub-stage headers chip-like.
- Add lane icons and tune lane label typography.
- Refine row tints and lane label/body contrast.

Why second:
Once the grid calms down, the map needs stronger landmarks so it does not become
visually mushy.

Risk:
Headers can become too playful or too tall. Keep the information density close to
the current layout.

### Phase 3: Cell Note Model

Scope:

- Add edit-mode note surfaces for non-empty cells.
- Add hover/selected empty-cell affordances.
- Tune text, bullets, boxes, and tags so each mode has a distinct but related
  presentation.
- Keep view mode cleaner than edit mode.

Why third:
This is the main emotional shift from spreadsheet to workspace.

Risk:
Nested-card feeling. Avoid raised cards inside colored row bands; use quiet
inset surfaces instead.

### Phase 4: Context Toolbar And Density

Scope:

- Lighten and compact the floating format toolbar.
- Add comfortable and compact density.
- Set edit mode to comfortable by default, view/export to compact.
- Persist density preference.

Why fourth:
The toolbar and density only make sense after the new cell model exists.

Risk:
Changing density can introduce scroll and sticky-header issues. Test large maps.

### Phase 5: Blank Map And Onboarding Polish

Scope:

- Add lane-specific empty prompts.
- Improve blank journey starter structure.
- Add clearer add-stage and add-step affordances.
- Remove prompts from view/export.

Why fifth:
These improvements matter most after the core surface feels right.

Risk:
Too much helper text can make the product feel tutorial-heavy. Keep prompts
contextual and sparse.

## Implementation Notes For The Current Codebase

Likely touchpoints in `index.html`:

- CSS tokens in `:root`, especially surface, border, accent, and row colors.
- Table/grid classes: `.bp`, `.bp td`, `.bpw`, `.ll`, `.dc`, `.stg-c`, `.sj-tc`.
- Row type classes: `.row-parties`, `.row-operator`, `.row-fs-human`,
  `.row-fs-system`, `.row-divider`, `.row-bs-human`, `.row-bs-system`,
  `.row-support`, `.row-pain`, `.row-verbatim`, `.row-emotion`, `.row-suggest`.
- Edit states: `td[contenteditable="true"]`, `.dc.cell-sel`,
  `.dc.cell-locked`, `.cell-lock-badge`.
- Cell mode classes: `.cell-tags`, `.cell-bullets`, `.cell-boxes`.
- Header controls: `.stg-c`, `.sub-c`, `.hdr-edit`, `.drag-handle`,
  `.menu-wrap`.
- Toolbar classes: `.cell-toolbar`, `.tb-btn`, `.tb-group`, `.tb-sep`.

Prefer changes that can be expressed through existing state and class names
before adding new state. Density is the likely exception because it needs a
stored user preference.

## Quality Checks

- Open a dense existing map and a blank map.
- Check edit mode and view mode separately.
- Check at desktop width, narrow laptop width, and print/export view.
- Verify sticky stage headers still align with body columns.
- Verify row drag, column drag, header menus, cell selection, tags, bullets,
  boxes, locks, and the format toolbar still work.
- Confirm no text overlaps at smaller widths.
- Confirm empty prompts never appear in export.
- Confirm keyboard focus is visible and not dependent on color alone.

## Decision Summary

The product should not chase the competitor's look. The better move is to keep
Lanescape's credible blueprint structure and make editing feel more object-based:
stage objects, step chips, lane identities, note surfaces, semantic dividers, soft
selection, contextual tools, and mode-aware density.

That gives the user the friendly "I can build this" feeling without losing the
serious "I can present this" quality.
