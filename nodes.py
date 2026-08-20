from comfy_api.latest import io, ui

# Carries a crop rectangle from one Simple Crop node to another (e.g. to keep a video
# crop and a separately rendered first-frame crop framed the same way) over a single
# connection instead of four INT sockets.
#
# The rectangle travels NORMALIZED (0-1 fractions of the source's width/height), not in
# pixels: the two sources routinely differ in resolution — a 960x540 video paired with a
# 1024x1024 rendered still — and copying raw pixel values across would silently frame a
# different region on each. Fractions keep the same relative region on both.
CropInfo = io.Custom("SIMPLE_CROP_INFO")


class SimpleCrop(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SimpleCrop",
            display_name="Simple Crop",
            category="image/transform",
            description=(
                "Crop an image or an image batch (video frame sequence) to a "
                "rectangle. Drag the box on the node's preview to set the region, "
                "or type exact pixel values. Connect crop_info from another Simple "
                "Crop node to reuse its rectangle instead."
            ),
            is_output_node=True,
            inputs=[
                io.Image.Input("image", tooltip="Image or batch of frames to crop."),
                io.Int.Input("x", default=0, min=0, max=999999, step=1,
                             tooltip="Crop box left edge, in pixels."),
                io.Int.Input("y", default=0, min=0, max=999999, step=1,
                             tooltip="Crop box top edge, in pixels."),
                io.Int.Input("width", default=512, min=1, max=999999, step=1,
                             tooltip="Crop box width, in pixels."),
                io.Int.Input("height", default=512, min=1, max=999999, step=1,
                             tooltip="Crop box height, in pixels."),
                CropInfo.Input(
                    "crop_info", optional=True,
                    tooltip="Optional: reuse the crop rectangle from another Simple "
                            "Crop node's crop_info output instead of x/y/width/height."
                ),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                CropInfo.Output("crop_info"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image, x: int, y: int, width: int, height: int, crop_info=None) -> io.NodeOutput:
        _b, h, w, _c = image.shape

        if crop_info is not None:
            # Scale the incoming fractions onto this image's own resolution.
            x = round(crop_info["x"] * w)
            y = round(crop_info["y"] * h)
            width = round(crop_info["width"] * w)
            height = round(crop_info["height"] * h)

        x0 = max(0, min(int(x), w - 1))
        y0 = max(0, min(int(y), h - 1))
        x1 = max(x0 + 1, min(x0 + int(width), w))
        y1 = max(y0 + 1, min(y0 + int(height), h))

        cropped = image[:, y0:y1, x0:x1, :]
        used_rect = {
            "x": x0 / w,
            "y": y0 / h,
            "width": (x1 - x0) / w,
            "height": (y1 - y0) / h,
            "source_width": w,
            "source_height": h,
        }

        # Only preview the first frame: for a video-length batch, previewing every
        # frame would render a whole filmstrip under the node. The full batch is
        # still returned as the actual data output below.
        payload = ui.PreviewImage(cropped[:1], cls=cls).as_dict()
        # Report the resolution actually received, so the UI can draw the crop box
        # against the real tensor rather than a guess. These can disagree: a decoder
        # may hand over a codec-aligned frame (e.g. 960x544 for a video whose display
        # size is 960x540), which the browser never shows.
        payload["simple_crop_source_size"] = [w, h]
        return io.NodeOutput(cropped, used_rect, ui=payload)
