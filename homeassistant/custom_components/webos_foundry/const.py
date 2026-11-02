"""Constants for the webOS Foundry integration."""

DOMAIN = "webos_foundry"
DEFAULT_PORT = 8765  # must match `wof serve`'s default port
CONF_TOKEN = "token"
PLATFORMS = ["sensor", "binary_sensor", "button"]

STATUS_INTERVAL = 15  # seconds, GET /api/status
DETAILS_INTERVAL = 60  # seconds, GET /api/details
