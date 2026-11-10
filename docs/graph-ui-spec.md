# Graph UI spec

How the graph view should behave. Prototype:
https://claude.ai/artifact/DLHXKwPJQ7TnTfUB5G27DG

Each rule should become a test.

## Terms

- **Box**: a file or a folder on screen.
- **Home**: where a box sits when nothing is squishing it. Set by the default layout or by dragging.
- **Chain**: boxes lined up in a row or column, so pushing one pushes the next.
- **Strip**: a `+N more` button on a folder's edge, standing in for hidden boxes.
- **Flow order**: the order boxes were laid out, left to right, then top to bottom.

## Default layout

- Runs once per folder, the first time it opens, on that folder's direct children. Positions are then saved.
- A box goes one column to the right of whatever imports it. Arrows between nested files count.
- In a circular import, the arrow that closes the circle is ignored.
- Within a column, boxes are sorted by indegree, then child count, then name.
- Columns are centered vertically.
- Padding between boxes is even by default, whatever their sizes.
- A folder opens at full spacing, showing about 5 children. The rest go behind `+N more`.
- A folder never hides just one child.

## Size

- A closed box's size comes from `nodeSize(childCount, indegree)`.
- Children set a folder's size. A strip never makes a folder bigger.
- A strip matches the folder's current size: top and bottom strips fill its width, and side strips fill its height, minus padding.
- A folder only reserves room for a strip on a side that has one.

## Dragging

- Every box can be dragged, including inside big folders.
- A dragged box comes to the front and stays there.
- Dragging a box past a folder's edge grows the folder.
- A box touching an edge is holding it out, so dragging it inward pulls the edge in, as far as the other boxes allow.
- On drop, anything underneath slides right or down, whichever is shorter, and anything it hits moves too. The dropped box stays put.
- A drop must never hide a box. The folder grows instead.

## Resizing

- Every box has a resize handle at its lower right.
- Neighbors follow live, by exactly the size change, so gaps stay the same.
- A folder can be made bigger than its children and stays that size.
- Shrinking works like a wall: the edge pushes boxes it touches, and they collide with and push the next ones. Their order never changes.
- `+N` only appears once a chain is fully squished.
- When a chain is jammed, only that chain loses a box: its latest in the flow, straight behind a strip.
- A chain keeps at least 3 boxes. With 3 jammed the folder stops shrinking. With 4 it can shrink to 3 plus `+1`.
- The layout depends only on homes and the folder's size, so growing is the exact reverse of shrinking.
- Hidden boxes come back squished, then spread out toward home as room appears.
- Growing in one direction never pulls in boxes hidden in the other direction.
- Growing brings back earlier boxes first, then later ones. The folder widens if a returning box needs it.

## `+N more`

- Each press moves by exactly one box.
- A single line of boxes slides through fixed slots, and the next box takes the free slot.
- Any other layout shifts as a whole, keeping boxes' positions relative to each other.
- The folder changes only by the difference in box sizes, and goes back to its normal size afterward.
- The graph only ever pushes right and down. A folder's left and top edges don't move.

## Opening folders

- Opening a child grows its parent and never adds to the parent's `+N`.
- Opening or closing a folder never makes two boxes swap sides.

## Arrows

- Arrows are plain curves, each with its own connection point on a box's side.
- An arrow connects to whichever side of a box is closest to its other end.
- When several arrows meet on one side, their connection points are spread evenly along it.
- An arrow goes under every box, except an open folder that holds one of its ends.
- Arrows to hidden boxes attach to the strip for that side.

## Painting

- A folder and everything inside it paint as one unit.
- Order follows the default layout, left to right, except for boxes brought to the front.

## Other

- Scrolling is always the global zoom. Folders don't scroll.
- Positions are saved per workspace and survive closing the graph.
- **Reset layout** returns to the default.

## Open questions

- A folder once ended up showing no boxes in the prototype. It went away, but the cause was never found. Needs a test.
- A rare overlap appeared after long chains of drags. Needs a test.