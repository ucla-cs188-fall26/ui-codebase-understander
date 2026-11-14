# Graph UI spec

How the graph view should behave. Prototype:
https://claude.ai/artifact/DLHXKwPJQ7TnTfUB5G27DG

Each rule should become a test.

## Terms

- **Box**: a file or a directory on screen.
- **Home**: where a box sits when nothing is squishing it. Set by the default layout or by dragging. It changes only when the user drags or resets the box, or a neighbor grows into it; squishing and turning pages never change it.
- **Chain**: boxes lined up in a row or column, so pushing one pushes the next.
- **Strip**: a `+N` button on a directory's edge, standing in for the boxes hidden on that side.
- **Page**: the part of a directory's layout it shows at once. The layout is cut into pages the size of the directory's window, starting at its top-left.
- **Flow order**: the order boxes were laid out, left to right, then top to bottom.

## Default layout

- Runs once per directory, the first time it opens, on all of that directory's direct children, so every child has a home even while hidden. Positions are then saved.
- A box goes one column to the right of whatever imports it. Arrows between nested files count.
- In a circular import, the arrow that closes the circle is ignored.
- Within a column, boxes are sorted by indegree, then child count, then name.
- Columns are centered vertically.
- Padding between boxes is even by default, whatever their sizes.
- A directory opens on its first page: the top-left of its layout, at full spacing, sized to show about 5 children. The rest wait behind strips on the sides their homes are on.
- At the top level, every node with an arrow in or out gets a box, plus up to 5 of the rest. The others wait in a strip below the top-level boxes.
- The top level isn't paged; it has no box to page.
- A directory never hides just one child.

## Size

- A closed box's size comes from `nodeSize(childCount, indegree)`.
- A directory's size is its page's size, plus room for any strips, until the user resizes it.
- A strip sits inside the directory with the same padding on every side: between it and the edge, and between it and the children. It's drawn as a dotted outline.
- A strip matches the directory's current size: bottom strips fill its width, and side strips fill its height, minus padding, stopping short of each other in the corner.
- A directory only reserves room for a strip on a side that has one.

## Dragging

- Only the selected box can be dragged: by its title strip if it's open, anywhere on it if it's closed. Pressing anywhere else, including unselected boxes and the inside of open directories, pans.
- A dragged box, with everything inside it, paints on top while dragging. Nothing needs to stay in front afterward, since siblings never overlap once a drop settles.
- While dragging, the box's home moves with it and its directory grows to hold it, so the directory's neighbors make room as it goes, the same as they will on drop. Nothing it's over is pushed until the drop.
- A box touching an edge is holding it out, so dragging it inward pulls the edge in, as far as the other boxes allow.
- Pushing happens on drop only, never while dragging.
- A dropped box lands exactly where it was let go, and nothing it didn't land on moves, even when the dropped box had grown and others were shifted to make room for it.
- On drop, anything underneath moves away from where the dropped box landed (comparing centers), in any direction, and anything it hits moves the same way. The dropped box stays put.
- A push never moves a box past a directory's left or top edge. If it would, the push goes right or down instead, whichever is shorter.
- The top level has no border, so boxes there can be dragged and pushed anywhere, in any direction.
- A drop must never hide a box. The directory grows instead.

## Resizing

- Every box has a resize handle at its lower right.
- Neighbors follow live, by exactly the size change, so gaps stay the same.
- A directory can be made bigger than its page needs, and stays that size. Bigger shows more: its window widens, and the children whose homes fall inside come in.
- Smaller than its page needs squishes the page first: gaps shrink, as below. Once they can't, the page gets smaller instead, and the boxes that no longer fit move to the next page, behind a strip, with the page counter updating. Growing does the reverse: gaps open up, then the page grows and boxes come back.
- A strip always means "on another page". Squishing never hides a box on its own.
- Shrinking squeezes each row (or column, from the bottom) by shrinking all its gaps in the same proportion, so gaps that started even stay even. Boxes keep their size, and their order never changes. Rows don't affect each other.
- A page keeps at least 3 columns in a row, and 3 rows in a column, where boxes stacked one above another count as one column. With 3 jammed the directory stops shrinking.
- The layout depends only on homes and the directory's size, so growing is the exact reverse of shrinking.
- Growing in one direction never pulls in boxes from pages in the other direction.
- Resizing changes where page lines fall, but never a home. The window's top-left stays put, so the same part of the layout stays in view.

## Strips and pages

- A strip shows on any side with hidden children (left, right, top, or bottom), counting the ones behind it.
- Clicking a strip turns the page that way: the window moves by one page, so what was shown goes behind a strip on the opposite side. The directory keeps its size, and no home changes.
- A page turn moves by the page's unsquished size, so a squished directory pages through the same children, drawn tighter.
- When a directory's layout is taller or wider than one page, its title shows where it is, dimmed: `↓ 2/3` for down, `→ 1/2` for across, both if both. A directory that fits on one page shows nothing.
- Resizing keeps the window's top-left where it was and recounts the pages.
- Showing a specific node (from the sidebar, or later a flow step) turns each directory holding it to the page it's on. It's in view, but not necessarily centered.
- Each directory's page is saved with the layout, so it reopens on the page it was left on.
- Strips and growing only push right and down. A directory's left and top edges never move.

## Opening directories

- Opening a child grows its parent and never adds to the parent's `+N`.
- Opening or closing a directory never makes two boxes swap sides.
- When a box grows (opening or resizing), only what's in its path moves, once, at that moment: siblings below it in its column move down by the growth, siblings beside it in its row move right, and anything those would run into moves along with them. Boxes off to the side stay put. Shrinking moves them back by the same amount, so closing a box right after opening it puts everyone back. A box is always drawn where its saved position says, so nothing shifts later on its own.

## Arrows

- Arrows are plain curves, each with its own connection point on a box's side.
- An arrow connects to whichever side of a box is closest to its other end.
- When several arrows meet on one side, their connection points are spread evenly along it.
- An arrow goes under every box, except the boxes at its ends and the open directories holding them. Its siblings' boxes and theirs count, however they're painted.
- Near a box it goes under, an arrow fades out first, so it doesn't look like it starts or ends there.
- Arrows to hidden boxes attach to the strip for that side.
- Selecting a box draws its arrows (either end is the box or inside it) in full. The arrow settings' strength decides the rest: Hidden draws none, Default draws them faint, and Full draws them in full. The setting is saved with the layout.
- An arrow standing for several imports is thicker, growing slower as the count rises, up to a limit. Hovering it shows the count.
- An arrow lives in the deepest folder holding both its ends. The arrow settings' depth (default 1, typed or stepped from 1 up to the repo's deepest level, where nothing is grouped) lets each end go at most that many levels below that folder; deeper ends attach to their folder at that level, and arrows landing on the same two boxes merge. A value below 1 becomes 1, and one above the deepest level becomes that level. The deepest level shows dimmed beside it.
- A selected box's arrows are the ones carrying any of its imports, wherever they're drawn, so a file's grouped arrows still light up.
- A selected arrow keeps its width and turns yellow, its tip included.
- An arrow's line stops at its head, and thicker arrows get bigger heads, so the line never shows past the tip.

## Painting

- A directory and everything inside it paint as one unit.
- Order follows the layout, left to right, except a box being dragged.
- The toolbar holds only icons: reset, fit, arrows, settings. Arrows and settings each open a popup; one is open at a time, and clicking outside or pressing Escape closes it.
- The box under the mouse gets a brighter border, unless it's selected or something is being dragged, panned, or resized.
- A selected box's border and a selected arrow are the same yellow.

## Other

- Scrolling is always the global zoom. Directories don't scroll; their pages turn only by clicking a strip.
- Positions are saved per workspace and survive closing the graph.
- **Reset layout** returns to how things first looked: the default layout and sizes, with everything inside closed. It works on the whole graph (after a confirmation) or on one selected node, which stays open or closed as it was.

## Open questions

- A directory once ended up showing no boxes in the prototype. It went away, but the cause was never found. Needs a test.
- A rare overlap appeared after long chains of drags. Needs a test.