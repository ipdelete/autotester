"""autotester Python rewrite backed by ttasks."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("autotester")
except PackageNotFoundError:  # pragma: no cover - editable tree before install
    __version__ = "0+unknown"

__all__ = ["__version__"]
