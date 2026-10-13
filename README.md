# Floorplan

A floor-planning web app for Google Chrome. It is two files, `index.html` and `app.js`, with no build step, no server and no dependencies. Plans are saved as JSON files in a folder you choose on your own disk.

## Running it

Open `index.html` in Google Chrome. That is all.

Chrome is required because saving uses the File System Access API (the "Open folder…" button). Until a folder is chosen, the drawing is kept only as a draft in the browser.

An internet connection is needed only for Google Fonts, if you add any.

## What it does

**Walls**
- Draw walls as rectangles; rectangles that touch or overlap merge into one wall outline.
- Walls are axis-aligned (no angled walls).

**Doors, doorways and windows**
- Doors have a frame size and a door size, a hinge side and an opening direction.
- Doorways are openings without a door.
- Windows have a size and a sill (width and depth).

**Dimensions**
- Every straight wall segment gets a dimension. A wall line with openings gets a chain (wall part, opening, wall part…) plus the overall length.
- Any dimension can be hidden, and brought back from the hidden-dimensions list or by clicking the wall line.
- A dimension can carry a "real size" that is shown instead of the drawn length, marked with `*`, without changing the plan.
- Free dimensions can be drawn between any two points, with optional rounding or a typed-in real size.
- Ceiling height marks and compass roses live on the dimensions layer.

**Objects, titles, notes**
- Objects are free shapes (furniture and the like): rectangles, round shapes, or polygons edited corner by corner. They can be moved, resized and rotated. They have a name, an optional description, a fill style (solid, diagonal, cross-hatch) and colour.
- Each rectangular object can show, per side: its side length, the gap to the nearest other object, and the gap to the nearest wall.
- Titles are free text that can sit on any layer.
- Comment notes are sticky-note shapes with wrapped text and a colour.

**Layers**
- Fixed Walls and Dimensions layers, plus any number of object layers.
- A layer can be hidden, or frozen (selectable but read-only). Layer order is the drawing order.
- Object and title defaults can be set for the whole plan or per layer.

**Appearance**
- Light and dark mode. Every colour has a light and a dark value; set one and the other is derived, or set both.
- Fonts for dimensions, objects and titles, including Google Fonts.
- Dimension line ends (arrows, V-arrows, ticks, dots), distance from the wall, object borders and hatch spacing.

**Other**
- Units: mm, cm or m. Snapping from 1 mm to 10 cm.
- Undo and redo.
- Export to PNG or PDF at up to 10 000 px on the long side.
- A small calculator in the side panel.
- A description field on everything, saved with the plan and never drawn.

## Controls

| Action | How |
| --- | --- |
| Select / move | `V`, then click or drag |
| Wall | `W`, drag a rectangle |
| Door / doorway / window | `D` / `O` / `N`, click a wall |
| Rectangle / round object | `B` / `E`, drag or click |
| Polygon object | `G`, click each corner; `Enter` or double-click to finish |
| Free dimension | `M`, drag from start to end |
| Ceiling height mark | `H`, click |
| Title | `T`, click |
| Comment note | `P`, drag or click |
| Compass rose | `C`, click |
| Nudge the selection | Arrow keys (one snap step) |
| Delete, or hide a dimension | `Delete` |
| Undo / redo | `⌘Z` / `⇧⌘Z` |
| Zoom | Scroll, or pinch |
| Pan | Drag empty space, `Space` + drag, middle button, or `Shift` + scroll |
| Draw without snapping | Hold `Alt` |
| Back to Select | `Esc` |

## Plan files

Each plan is one `.json` file in the chosen folder and is saved automatically after every change. All lengths are stored in millimetres whatever unit is displayed. The file also records the app name, version and repository it was written by.

## Limitations

- Chrome only.
- Walls cannot be drawn at an angle.
- Hidden dimensions, real sizes and descriptions on dimensions are tied to the position of the wall line they belong to; they survive moving a whole wall but not reshaping it.
- PDF export contains the plan as an image, not as vector graphics.

## Credits

Tool and layer icons are from [Material Design Icons](https://pictogrammers.com/library/mdi/) (Apache License 2.0), embedded in the page.
