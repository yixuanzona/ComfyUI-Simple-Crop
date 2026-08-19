# ComfyUI Simple Crop

A single, visual crop node for ComfyUI: drag a box directly on the node's preview
to crop an image or a video (frame batch). `IMAGE` in, `IMAGE` out.

## Features

- Drag-to-crop right on the node — no separate preview node needed.
- Works the same way on images and video frame batches, since ComfyUI's `IMAGE`
  type is already a batch (`[B, H, W, C]`).
- Live preview before you even run the workflow — works with `LoadImage`,
  VideoHelperSuite's `Load Video`, and ComfyUI's built-in `Load Video` + `Get
  Video Components`.
- After running once, the node's own preview updates to the cropped result, so
  you can sanity-check the crop at a glance.
- Optional `crop_info` output/input: connect one Simple Crop node's `crop_info`
  into another's to make it reuse the same rectangle — handy for keeping a
  video crop and its extracted first-frame crop in sync.

## Install

Copy (or symlink) this folder into ComfyUI's `custom_nodes/` directory, then
restart ComfyUI.

## Usage

1. Connect any `IMAGE` output into `Simple Crop`.
2. A preview of the source appears on the node. Drag the corners, edges, or
   inside of the blue box to set the crop region — or type exact `x` / `y` /
   `width` / `height` values below it.
3. Run the workflow. The `IMAGE` output can go to `SaveImage`, VideoHelperSuite's
   `Video Combine`, or any other node that takes `IMAGE`.
4. To keep two crops in sync (e.g. a video and its first frame), connect one
   node's `crop_info` output into another node's `crop_info` input. The
   receiving node's box then follows the source node's box live.

See [SPEC.md](SPEC.md) for design notes.
