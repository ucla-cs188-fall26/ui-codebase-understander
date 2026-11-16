# Graph UI spec

How the graph view behaves. Each rule should have a test. Prototype:
https://claude.ai/artifact/DLHXKwPJQ7TnTfUB5G27DG

## Terms

- **Box**: a file or directory on screen. The repo is a box too, the root, around everything.
- **Home**: where a box sits before any squishing. Set by the default layout or by dragging, and moved only by dragging, resetting, or a neighbor growing into it.
- **Strip**: a `+N` button on a directory's edge, standing in for the children on other pages that way.
- **Page**: the part of a directory's children it shows at once.
- **Flow order**: left to right, then top to bottom.

## Default layout

- Runs once per directory, the first time it opens, on all its direct children, so every child has a home even while hidden.
- A box goes one column right of whatever imports it. Arrows between nested files count. In an import cycle, the arrow closing it is ignored.
- Within a column, boxes are sorted by indegree, then child count, then name. Columns are centered vertically, with even gaps.
- A directory opens on its first page, at full spacing, sized to show about 5 children.
- The root's first page holds every top-level node with an arrow in or out, plus up to 5 others, at most 5 down any column. Nodes in the flow are laid out first, so configs and docs land on later pages.

## Size

- A closed box's size comes from `nodeSize(childCount, indegree)`.
- Until the user resizes it, a directory is its page's size plus room for its strips, and grows or shrinks with its children.
- A strip sits inside the directory with even padding on every side, as a dotted outline. Bottom and top strips span the width, side strips the height, stopping short of each other in the corners.
- A directory only keeps room for a strip on a side that has one.

## Resizing

- Every box has a resize handle at its lower right. Neighbors move live by exactly the size change.
- Dragging a corner is the only thing that moves children to other pages. Nothing else does: not opening, closing, dropping, turning pages, or reloading.
- A resized directory's pages are cut to fit it: columns across, each as wide as fits, then pages down each column, each as tall as fits. Each page leaves room for exactly the strips it has, so every page fits the box.
- Shrinking squishes first, shrinking every gap in a row (or column) in proportion, so even gaps stay even. Boxes keep their size and order. Once gaps can't shrink, children move to other pages. A page never holds more than it would at full spacing.
- Growing back to a size gives exactly the pages it had.
- The smallest size is room for the biggest child, plus only the strips its pages need at that size, so a directory can always be resized back to the size it opened at.
- Pages are cut from the current page in a direction the user has turned in, and from the layout's edge otherwise. A top or left strip only ever appears after turning down or right.
- Resizing never changes a home. The page being shown stays where it's drawn, so boxes the user moved stay put.
- Growing in one direction never pulls in children from pages in the other direction.

## Pages and strips

- A strip shows on any side with children on other pages that way, counting them.
- Clicking a strip turns to the nearest page that way with children on it. Turning never changes a home, and never resizes a directory the user resized.
- A page is drawn from where it was last drawn, so a box moved on it stays put after turning away and back. A page never seen is drawn from the top-left of its boxes.
- A child stays on its page until the directory is resized or reset. Pushing and dragging never move it to another page; one pushed or dropped past the page's edge stays, and the directory grows to hold it.
- Strips and growing only push right and down. A directory's left and top edges never move.
- With more than one page, the title shows which one, dimmed after the name: `2/4`, counting pages with children in reading order (top to bottom, then left to right). One page shows nothing.
- Clicking the page number lists the pages, each with its first few names, and picking one turns to it. Clicking outside, zooming, or Escape closes the list.
- Showing a node (from the sidebar, or later a flow step) opens and turns each directory holding it so it's in view, though not necessarily centered.
- Jumping to a node opens the directories around it. The next jump closes the ones it opened that aren't on the way, but never one holding a directory the user opened. Opening or closing one by hand makes it the user's.
- Each directory's page is saved, so it reopens where it was left.

## Opening and closing

- Opening a child grows its parent and never adds to the parent's `+N`. In a resized directory, the directory grows by as much as the child did, and more if its page still needs room. That extra room goes away once nothing needs it.
- When a box grows, only what's in its path moves, at that moment: siblings below it in its column move down, siblings beside it in its row move right, and anything those run into moves with them. A box pushed both ways carries along anything it would land on. Nothing shifts later on its own.
- Each box remembers whom it pushed and how far, so closing puts everything back exactly, in any order. A box whose way back is blocked moves back once the way is clear. A box the user drags stays where they put it.
- Opening or closing never makes two boxes swap sides.

## Dragging

- Only the selected box can be dragged: by its title if it's open, anywhere on it if closed. Pressing anywhere else pans.
- A dragged box and everything inside it paint on top while dragging, over the arrows it covers.
- While dragging, the box's home moves with it and its directory grows to hold it, so the directory's neighbors make room live. A box touching an edge holds it out, so dragging it inward pulls the edge in, as far as the other boxes allow.
- Nothing is pushed until the drop. A dropped box lands exactly where it was let go, and nothing it didn't land on moves.
- On drop, anything underneath, on any page, moves away from the dropped box (comparing centers), and each box pushed passes its push on the same way, so nothing ends up back under the dropped box. A push never crosses a directory's left or top edge; it goes right or down instead, whichever is shorter.
- A drop never hides a box. The directory grows instead.
- The root can't be dragged or closed. It can be resized and reset, and its edges hold boxes in, like any directory.

## Arrows

- Arrows are plain curves. Each connects to the side of a box closest to its other end, with its own connection point.
- Each end curves out of its side by half how far the arrow travels that way, so an arrow from a side next to the one facing its target bends out a little and turns, instead of looping wide.
- An end goes straight across where its two boxes overlap, or else to the point on the side nearest the other box, clear of the corners.
- Ends sharing a side are nudged just far enough apart not to overlap, keeping their order so they don't cross at the box. A side too crowded moves its outermost ends to the neighboring sides, those whose other boxes lie furthest that way first; one still too crowded spreads its ends evenly.
- Arrows leaving the same side of a box start from one shared point and split on their way; their heads stay apart.
- An arrow goes under every box except the ones at its ends and the open directories holding them. Near a box it goes under, it fades out, so it doesn't look like it starts or ends there.
- Arrows to hidden boxes attach to the strip for that side.
- Selecting a box draws its arrows in full: any arrow with an end that is the box or inside it. The arrow setting decides the rest: Hidden draws none, Default draws them faint, Full draws them in full. It's saved with the layout.
- An arrow standing for several imports is thicker, growing slower as the count rises, up to a limit. Hovering shows the count.
- An arrow lives in the deepest folder holding both its ends. The depth setting (default 1, from 1 to the repo's deepest level) lets each end go at most that many levels below that folder; deeper ends attach to their folder at that level, and arrows landing on the same two boxes merge. Values out of range are clamped, and the deepest level shows dimmed beside it.
- A selected box's arrows start from the box itself, even where the depth would merge them into a folder around it, and include every arrow carrying any of its imports. A selected arrow keeps its ends the same way.
- A selected arrow keeps its width and turns yellow, tip included.
- A line stops at its head, and thicker arrows get bigger heads, so the line never shows past the tip.

## Painting

- The background is a faint dot grid that pans and zooms with the graph, spacing out when zoomed far out.
- The root is see-through, with a faint dashed border, titled with the repo's name. Its title doesn't show the move cursor.
- Each box is one step lighter, toward the theme's text color, than the box around it. Folders have an accent bar down their left edge and a faint tint in their title; files stay neutral.
- Folder, file, arrow, and highlight colors can be set in VS Code's settings (`codeflow.*`); empty ones follow the theme. Changes apply to an open graph right away.
- A directory and everything inside it paint as one unit, in layout order, left to right, except a box being dragged.
- The toolbar holds only icons: reset, fit, arrows, settings. Arrows and settings each open a popup, one at a time; clicking outside or Escape closes it.
- The box under the mouse gets a brighter border, unless it's selected or something is being dragged, panned, or resized. A selected box's border and a selected arrow are the same yellow.

## Other

- Scrolling always zooms the whole graph. Directories don't scroll; their pages turn only by clicking a strip.
- Positions are saved per workspace and survive closing the graph.
- The sidebar lists what the selected box imports and what imports it, grouped the way its arrows are (the depth setting), most imports first, with counts. A folder row opens to what's inside it.
- Selecting an arrow shows its two ends and its import count, then the files at each end, grouped by the folders inside each end's box.
- A file row's open button opens the file. Opening the row (▸) lists each place the import is written; clicking one opens the file with that line selected.
- **Reset layout** returns to the default layout and sizes, with everything inside closed: the whole graph (after confirming), or one selected node, which stays open or closed.
