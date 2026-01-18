DROP TABLE IF EXISTS AuditLogs;
DROP TABLE IF EXISTS Entries;
DROP TABLE IF EXISTS Users;

-- Users table now includes 'transports' to support hybrid/cross-device flows
CREATE TABLE Users (
    id TEXT PRIMARY KEY,
    credential_id TEXT UNIQUE,
    public_key BLOB,
    counter INTEGER,
    transports TEXT -- Stores JSON array like ["internal", "hybrid"]
);

CREATE TABLE Entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    title TEXT NOT NULL,
    email TEXT,
    date_val TEXT,
    slider_val INTEGER,
    is_active BOOLEAN,
    tags_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE AuditLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    user_id TEXT,
    action TEXT,
    ip TEXT,
    headers_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
