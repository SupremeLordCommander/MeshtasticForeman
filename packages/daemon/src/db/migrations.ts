import type { PGlite } from "@electric-sql/pglite";

const migrations: string[] = [
  /* 001 – initial schema */
  `
  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    port        TEXT NOT NULL,
    hw_model    TEXT,
    firmware    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS nodes (
    node_id       BIGINT NOT NULL,
    device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    long_name     TEXT,
    short_name    TEXT,
    mac_address   TEXT,
    hw_model      INT,
    public_key    TEXT,
    last_heard    TIMESTAMPTZ,
    snr           REAL,
    hops_away     INT,
    latitude      DOUBLE PRECISION,
    longitude     DOUBLE PRECISION,
    altitude      INT,
    PRIMARY KEY (node_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    packet_id     BIGINT NOT NULL,
    device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    from_node_id  BIGINT NOT NULL,
    to_node_id    BIGINT NOT NULL,
    channel_index INT NOT NULL DEFAULT 0,
    text          TEXT NOT NULL,
    rx_time       TIMESTAMPTZ NOT NULL,
    rx_snr        REAL,
    rx_rssi       INT,
    hop_limit     INT,
    want_ack      BOOLEAN NOT NULL DEFAULT false,
    via_mqtt      BOOLEAN NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS messages_device_time ON messages(device_id, rx_time DESC);
  CREATE INDEX IF NOT EXISTS messages_channel ON messages(device_id, channel_index, rx_time DESC);

  CREATE TABLE IF NOT EXISTS packets (
    id            TEXT PRIMARY KEY,
    packet_id     BIGINT NOT NULL,
    device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    from_node_id  BIGINT NOT NULL,
    to_node_id    BIGINT NOT NULL,
    channel       INT NOT NULL,
    portnum       INT NOT NULL,
    portnum_name  TEXT NOT NULL,
    rx_time       TIMESTAMPTZ NOT NULL,
    rx_snr        REAL,
    rx_rssi       INT,
    hop_limit     INT,
    hop_start     INT,
    want_ack      BOOLEAN NOT NULL DEFAULT false,
    via_mqtt      BOOLEAN NOT NULL DEFAULT false,
    payload_raw   TEXT,
    decoded_json  JSONB
  );

  CREATE INDEX IF NOT EXISTS packets_device_time ON packets(device_id, rx_time DESC);
  CREATE INDEX IF NOT EXISTS packets_portnum ON packets(device_id, portnum, rx_time DESC);

  CREATE TABLE IF NOT EXISTS channels (
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    idx         INT NOT NULL,
    name        TEXT,
    role        INT NOT NULL DEFAULT 0,
    psk         TEXT,
    PRIMARY KEY (device_id, idx)
  );

  CREATE TABLE IF NOT EXISTS waypoints (
    id          BIGINT NOT NULL,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    icon        INT,
    locked_to   BIGINT,
    expire      TIMESTAMPTZ,
    PRIMARY KEY (id, device_id)
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
];

export async function runMigrations(db: PGlite) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await db.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  const applied = new Set(rows.map((r) => r.version));

  for (let i = 0; i < migrations.length; i++) {
    const version = i + 1;
    if (applied.has(version)) continue;

    console.log(`[db] applying migration ${version}`);
    await db.transaction(async (tx) => {
      await tx.exec(migrations[i]);
      await tx.query(
        "INSERT INTO schema_migrations(version) VALUES ($1)",
        [version]
      );
    });
  }
}
