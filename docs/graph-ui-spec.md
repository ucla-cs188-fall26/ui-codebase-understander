# Graph UI spec

How the graph view should behave. Prototype:
https://claude.ai/artifact/DLHXKwPJQ7TnTfUB5G27DG

Each rule should become a test.

## Terms

- **Box**: a file or a directory on screen.
- **Home**: where a box sits when nothing is squishing it. Set by the default layout or by dragging.
- **Chain**: boxes lined up in a row or column, so pushing one pushes the next.
- **Strip**: a `+N more` button on a directory's edge, standing in for hidden boxes.
- **Flow order**: the order boxes were laid out, left to right, then top to bottom.

## Default layout

- Runs once per directory, the first time it opens, on that directory's direct children. Positions are then saved.
- A box goes one column to the right of whatever imports it. Arrows between nested files count.
- In a circular import, the arrow that closes the circle is ignored.
- Within a column, boxes are sorted by indegree, then child count, then name.
- Columns are centered vertically.
- Padding between boxes is even by default, whatever their sizes.
- A directory opens at full spacing, showing about 5 children. The rest go behind a strip on the side the default layout would have put them.
- At the top level, every node with an arrow in or out gets a box, plus up to 5 of the rest. The others wait in a strip below the top-level boxes.
- A directory never hides just one child.

## Size

- A closed box's size comes from `nodeSize(childCount, indegree)`.
- Children set a directory's size, plus room for any strip.
- A strip sits inside the directory with the same padding on every side: between it and the edge, and between it and the children. It's drawn as a dotted outline.
- A strip matches the directory's current size: bottom strips fill its width, and side strips fill its height, minus padding, stopping short of each other in the corner.
- A directory only reserves room for a strip on a side that has one.

## Dragging

- Only the selected box can be dragged: by its title strip if it's open, anywhere on it if it's closed. Pressing anywhere else, including unselected boxes and the inside of open directories, pans.
- A dragged box, with everything inside it, paints on top while dragging. Nothing needs to stay in front afterward, since siblings never overlap once a drop settles.
- While dragging, only the dragged box moves; nothing else changes until the drop. Dropping a box past a directory's edge grows the directory.
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
- A directory can be made bigger than its children and stays that size.
- Shrinking squeezes each row (or column, from the bottom) by shrinking all its gaps in the same proportion, so gaps that started even stay even. Boxes keep their size, and their order never changes. Rows don't affect each other.
- `+N` only appears once a chain is fully squished.
- When a chain is jammed, only that chain loses a box: its latest in the flow, straight behind a strip.
- A row keeps at least 3 columns, where boxes stacked one above another count as one column. With 3 jammed the directory stops shrinking. With 4 it can shrink to 3 plus `+1`.
- The layout depends only on homes and the directory's size, so growing is the exact reverse of shrinking.
- Hidden boxes come back squished, then spread out toward home as room appears.
- Growing in one direction never pulls in boxes hidden in the other direction.
- Growing brings back earlier boxes first, then later ones. The directory widens if a returning box needs it.

## `+N more`

- Each press moves by exactly one box.
- A single line of boxes slides through fixed slots, and the next box takes the free slot.
- Any other layout shifts as a whole, keeping boxes' positions relative to each other.
- The directory changes only by the difference in box sizes, and goes back to its normal size afterward.
- Strips and growing only push right and down. A directory's left and top edges never move.

## Opening directories

- Opening a child grows its parent and never adds to the parent's `+N`.
- Opening or closing a directory never makes two boxes swap sides.
- When a box grows (opening or resizing), only what's in its path moves, once, at that moment: siblings below it in its column move down by the growth, siblings beside it in its row move right, and anything those would run into moves along with them. Boxes off to the side stay put. Shrinking moves them back by the same amount, so closing a box right after opening it puts everyone back. A box is always drawn where its saved position says, so nothing shifts later on its own.

## Arrows

- Arrows are plain curves, each with its own connection point on a box's side.
- An arrow connects to whichever side of a box is closest to its other end.
- When several arrows meet on one side, their connection points are spread evenly along it.
- An arrow goes under every box, except an open directory that holds one of its ends.
- Arrows to hidden boxes attach to the strip for that side.

## Painting

- A directory and everything inside it paint as one unit.
- Order follows the layout, left to right, except a box being dragged.

## Other

- Scrolling is always the global zoom. Directories don't scroll.
- Positions are saved per workspace and survive closing the graph.
- **Reset layout** returns to how things first looked: the default layout and sizes, with everything inside closed. It works on the whole graph (after a confirmation) or on one selected node, which stays open or closed as it was.

## Open questions

- A directory once ended up showing no boxes in the prototype. It went away, but the cause was never found. Needs a test.
- A rare overlap appeared after long chains of drags. Needs a test.