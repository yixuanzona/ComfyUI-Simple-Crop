from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .nodes import SimpleCrop

WEB_DIRECTORY = "./js"


class SimpleCropExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [SimpleCrop]


async def comfy_entrypoint() -> SimpleCropExtension:
    return SimpleCropExtension()
