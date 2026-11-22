import os
import sys
from logging import INFO

import structlog
from structlog.processors import (
    JSONRenderer,
    LogfmtRenderer,
    TimeStamper,
    add_log_level,
    format_exc_info,
)


def configure_logging() -> None:
    structlog.configure(
        processors=[
            add_log_level,
            TimeStamper(fmt="iso"),
            format_exc_info,
            JSONRenderer() if os.environ.get("LOG_FORMAT") == "json" else LogfmtRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(INFO),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
    )
