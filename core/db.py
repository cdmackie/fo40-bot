import aiosqlite
from pathlib import Path

DB_PATH = Path("data/bot.db")

# Idempotent CREATE statements. Run on every startup.
# When you need a real schema change later, add a migrations table and
# version-gated ALTERs.
SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS users (
        discord_id INTEGER PRIMARY KEY,
        reddit_username TEXT,
        joined_at TIMESTAMP,
        first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS mod_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mod_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS strikes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mod_id INTEGER NOT NULL,
        severity INTEGER NOT NULL,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS dm_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER NOT NULL,
        reported_user_id INTEGER NOT NULL,
        screenshot_url TEXT,
        context TEXT,
        status TEXT DEFAULT 'open',
        mod_decision TEXT,
        mod_channel_message_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS birthdays (
        user_id INTEGER PRIMARY KEY,
        month INTEGER NOT NULL,
        day INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS reaction_role_messages (
        message_id INTEGER PRIMARY KEY,
        channel_id INTEGER NOT NULL,
        config_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_text TEXT NOT NULL,
        category TEXT,
        last_used TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ban_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        user_id INTEGER,
        reddit_username TEXT,
        action TEXT NOT NULL,
        reason TEXT,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    # Indexes for the common query patterns the cogs will use.
    "CREATE INDEX IF NOT EXISTS idx_mod_notes_user ON mod_notes(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_strikes_user ON strikes(user_id, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_dm_reports_reported ON dm_reports(reported_user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_dm_reports_status ON dm_reports(status)",
    "CREATE INDEX IF NOT EXISTS idx_ban_sync_reddit ON ban_sync_log(reddit_username)",
]


async def init_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        for stmt in SCHEMA:
            await db.execute(stmt)
        await db.commit()


def connect():
    """Use as: `async with connect() as db: ...`"""
    return aiosqlite.connect(DB_PATH)
