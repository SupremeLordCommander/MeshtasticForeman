"""
Meshtastic serial-to-MQTT gateway.

Receives packets from a serially-connected Meshtastic device and publishes
them as binary ServiceEnvelope protobufs to the 'e' (encoded) MQTT topic so
nodes appear on meshtastic.org/map and other standard consumers.

The previous JSON/2/json/... approach was a diagnostic workaround.
This version produces the same wire format the device firmware would emit
if it had built-in WiFi (which nRF52-based devices like the Wio Tracker do not).

Requirements:
    pip install -r requirements.txt

Usage:
    cp .env.example .env   # fill in MESHTASTIC_PORT etc.
    python proxy.py
"""

import base64
import os
from pathlib import Path
import random
import struct
import time
import traceback
from typing import Optional

import meshtastic.serial_interface
import paho.mqtt.client as mqtt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from dotenv import load_dotenv
from google.protobuf.json_format import ParseDict
from meshtastic import mesh_pb2, portnums_pb2, telemetry_pb2
from pubsub import pub

# ServiceEnvelope and MapReport moved to mqtt_pb2 in newer library versions
try:
    from meshtastic import mqtt_pb2
    ServiceEnvelope = mqtt_pb2.ServiceEnvelope
    MapReport       = mqtt_pb2.MapReport
except (ImportError, AttributeError):
    ServiceEnvelope = mesh_pb2.ServiceEnvelope  # type: ignore[attr-defined]
    MapReport       = None

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Load .env from repo root (one level up from Samples/)
_here = Path(__file__).parent
load_dotenv(_here.parent / ".env")  # repo root first
load_dotenv(_here / ".env")         # local Samples/.env as override

SERIAL_PORT = os.getenv("MESHTASTIC_PORT", "")           # blank = auto-detect
MQTT_BROKER = os.getenv("MQTT_BROKER", "mqtt.meshtastic.org")
MQTT_PORT   = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER   = os.getenv("MQTT_USER", "meshdev")
MQTT_PASS   = os.getenv("MQTT_PASS", "large4cats")
MQTT_ROOT   = os.getenv("MQTT_ROOT", "msh/US/CA/Humboldt/Eureka")

# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------

# The well-known default Meshtastic channel key.
# PSK value "AQ==" (single byte 0x01) on the device expands to this 16-byte key.
# This is public — it is hardcoded identically in every Meshtastic client and
# documented at meshtastic.org. It is NOT a secret for the default channel.
DEFAULT_KEY: bytes = base64.b64decode("1PG7OiApB1nwvP+rz05pAQ==")


def expand_psk(raw_psk: bytes) -> bytes:
    """Convert a raw channel PSK from the device into an AES key."""
    if not raw_psk or raw_psk == b"\x01":
        return DEFAULT_KEY
    if len(raw_psk) in (16, 32):
        return raw_psk
    # Shorter custom keys: zero-pad to 16 bytes
    return raw_psk.ljust(16, b"\x00")[:16]


def encrypt_payload(key: bytes, packet_id: int, from_node: int, plaintext: bytes) -> bytes:
    """
    AES-CTR encrypt a serialized Data protobuf.

    Nonce layout (matches Meshtastic firmware CryptoEngine.cpp):
        bytes 0–7:  packet_id as little-endian uint64 (upper 4 bytes = 0)
        bytes 8–15: from_node as little-endian uint64 (upper 4 bytes = 0)
    """
    nonce = struct.pack("<Q", packet_id & 0xFFFFFFFF) + struct.pack("<Q", from_node & 0xFFFFFFFF)
    cipher = Cipher(algorithms.AES(key), modes.CTR(nonce), backend=default_backend())
    enc = cipher.encryptor()
    return enc.update(plaintext) + enc.finalize()


# ---------------------------------------------------------------------------
# Payload re-serialisation
# ---------------------------------------------------------------------------

# Map portnum name → (protobuf class for inner payload, key in decoded dict)
# MAP_REPORT_APP is added at runtime once MapReport is confirmed importable.
_PORTNUM_PROTO = {
    "POSITION_APP":  (mesh_pb2.Position,      "position"),
    "NODEINFO_APP":  (mesh_pb2.User,           "user"),
    "TELEMETRY_APP": (telemetry_pb2.Telemetry, "telemetry"),
    "ROUTING_APP":   (mesh_pb2.Routing,        "routing"),
}
if MapReport is not None:
    _PORTNUM_PROTO["MAP_REPORT_APP"] = (MapReport, "mapReport")

# Portnums that use "map" as the MQTT channel name instead of the radio channel
_MAP_CHANNEL_PORTNUMS = {"MAP_REPORT_APP"}

SELF_PUB_INTERVAL = 900   # re-announce our own node every 15 minutes


def serialise_payload(decoded: dict) -> Optional[bytes]:
    """
    Re-serialise the decoded inner payload back to protobuf bytes so we can
    re-encrypt it and wrap it in a ServiceEnvelope.

    The meshtastic Python library decrypts packets before exposing them via
    pubsub, so we must reverse that step to publish on the 'e' topic.

    Returns None for packets that should be silently skipped.
    """
    portnum = decoded.get("portnum", "")

    if portnum == "TEXT_MESSAGE_APP":
        return decoded.get("text", "").encode("utf-8")

    if portnum == "POSITION_APP":
        pos = decoded.get("position", {})
        # Skip position reports with no valid GPS fix
        if not pos.get("latitudeI") and not pos.get("longitudeI"):
            return None

    if portnum in _PORTNUM_PROTO:
        pb_class, field = _PORTNUM_PROTO[portnum]
        field_data = decoded.get(field)
        if not field_data:
            return None
        try:
            pb = ParseDict(field_data, pb_class(), ignore_unknown_fields=True)
            return pb.SerializeToString()
        except Exception as exc:
            print(f"[serialise] {portnum}: {exc}")
            return None

    return None  # unsupported portnum — skip quietly


# ---------------------------------------------------------------------------
# ServiceEnvelope construction
# ---------------------------------------------------------------------------

def build_envelope(
    packet_id:   int,
    from_num:    int,
    to_num:      int,
    channel_idx: int,
    rx_time:     int,
    hop_limit:   int,
    want_ack:    bool,
    encrypted:   bytes,
    channel_name: str,
    gateway_id:  str,
) -> bytes:
    mesh_pkt = mesh_pb2.MeshPacket()
    mesh_pkt.id        = packet_id
    mesh_pkt.to        = to_num
    mesh_pkt.channel   = channel_idx
    mesh_pkt.rx_time   = rx_time
    mesh_pkt.hop_limit = hop_limit
    mesh_pkt.want_ack  = want_ack
    mesh_pkt.encrypted = encrypted
    # 'from' is a Python keyword — use setattr to set the proto field
    setattr(mesh_pkt, "from", from_num)

    return ServiceEnvelope(
        packet=mesh_pkt,
        channel_id=channel_name,
        gateway_id=gateway_id,
    ).SerializeToString()


def build_map_envelope(
    packet_id: int,
    from_num:  int,
    data:      mesh_pb2.Data,
    gateway_id: str,
) -> bytes:
    """
    Build a ServiceEnvelope for the 2/map/ topic.

    Map reports use an UNENCRYPTED MeshPacket (decoded variant) so the map
    server can read them without needing the channel key.  The channel_id is
    set to "LongFast" to match the format real firmware devices emit.
    """
    mesh_pkt = mesh_pb2.MeshPacket()
    mesh_pkt.id        = packet_id
    mesh_pkt.to        = 0xFFFFFFFF
    mesh_pkt.rx_time   = int(time.time())
    mesh_pkt.hop_limit = 3
    mesh_pkt.decoded.CopyFrom(data)
    setattr(mesh_pkt, "from", from_num)

    return ServiceEnvelope(
        packet=mesh_pkt,
        channel_id="LongFast",
        gateway_id=gateway_id,
    ).SerializeToString()


# ---------------------------------------------------------------------------
# MQTT client
# ---------------------------------------------------------------------------

_mqtt_ready = False


def _on_connect(client, userdata, flags, rc):
    global _mqtt_ready
    _mqtt_ready = rc == 0
    print(f"[mqtt] {'connected to ' + MQTT_BROKER if _mqtt_ready else 'connect failed rc=' + str(rc)}")


def _on_disconnect(client, userdata, rc):
    global _mqtt_ready
    _mqtt_ready = False
    print(f"[mqtt] disconnected (rc={rc}), will reconnect...")


try:
    mq = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
except AttributeError:
    mq = mqtt.Client()  # type: ignore[call-arg]

mq.on_connect    = _on_connect
mq.on_disconnect = _on_disconnect
mq.username_pw_set(MQTT_USER, MQTT_PASS)
mq.reconnect_delay_set(min_delay=1, max_delay=30)
mq.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
mq.loop_start()

# ---------------------------------------------------------------------------
# Meshtastic serial interface
# ---------------------------------------------------------------------------

iface: Optional[meshtastic.serial_interface.SerialInterface] = None
_channel_keys: dict[int, bytes] = {}   # channel index → AES key
_gateway_id = "!00000000"             # filled in after interface connects


def _init_device():
    """Read channel keys and local node ID from the device after connect."""
    global _gateway_id
    try:
        for idx, ch in enumerate(iface.localNode.channels):  # type: ignore[union-attr]
            raw = bytes(ch.settings.psk)
            if raw:
                _channel_keys[idx] = expand_psk(raw)
                label = "default" if raw == b"\x01" else "custom"
                name  = ch.settings.name or "LongFast"
                print(f"[keys] ch{idx} ({name}): {label} key loaded")
    except Exception as exc:
        print(f"[keys] could not read channel PSKs: {exc}")

    try:
        node_num = iface.localNode.nodeNum  # type: ignore[union-attr]
        _gateway_id = f"!{node_num:08x}"
    except Exception as exc:
        print(f"[gateway] could not read local node num: {exc}")

    print(f"[gateway] id = {_gateway_id}")

    # Wait up to 10s for MQTT to connect, then announce ourselves
    for _ in range(20):
        if _mqtt_ready:
            break
        time.sleep(0.5)
    _publish_self()


def _channel_name(ch_idx: int) -> str:
    try:
        ch = iface.localNode.channels[ch_idx]  # type: ignore[union-attr]
        return ch.settings.name or "LongFast"
    except Exception:
        return "LongFast"


# ---------------------------------------------------------------------------
# Proactive self-announcement
# ---------------------------------------------------------------------------

def _publish_map_report(report_bytes: bytes) -> None:
    """
    Publish a MapReport as an unencrypted ServiceEnvelope to the 2/map/ topic.

    Topic has no node-ID suffix — all gateways share the same topic path.
    """
    node_num  = iface.localNode.nodeNum  # type: ignore[union-attr]
    packet_id = random.randint(1, 0xFFFFFFFF)
    try:
        portnum_int = portnums_pb2.PortNum.Value("MAP_REPORT_APP")
    except ValueError:
        portnum_int = 73  # fallback value from Meshtastic portnums

    data           = mesh_pb2.Data(portnum=portnum_int, payload=report_bytes)
    envelope_bytes = build_map_envelope(packet_id, node_num, data, _gateway_id)

    topic  = f"{MQTT_ROOT}/2/map/"
    result = mq.publish(topic, envelope_bytes)
    status = "ok" if result.rc == mqtt.MQTT_ERR_SUCCESS else f"FAIL rc={result.rc}"
    print(f"[self] {status}  MAP_REPORT_APP → {topic}  ({len(envelope_bytes)}B)")


def _publish_packet(portnum_name: str, payload_bytes: bytes, channel_name: str) -> None:
    """Encrypt payload_bytes and publish a ServiceEnvelope on behalf of our own node."""
    node_num = iface.localNode.nodeNum  # type: ignore[union-attr]
    packet_id = random.randint(1, 0xFFFFFFFF)
    try:
        portnum_int = portnums_pb2.PortNum.Value(portnum_name)
    except ValueError:
        portnum_int = 0

    data_bytes = mesh_pb2.Data(
        portnum=portnum_int,
        payload=payload_bytes,
    ).SerializeToString()

    key = _channel_keys.get(0, DEFAULT_KEY)
    encrypted = encrypt_payload(key, packet_id, node_num, data_bytes)

    envelope_bytes = build_envelope(
        packet_id, node_num, 0xFFFFFFFF, 0, int(time.time()),
        3, False, encrypted, channel_name, _gateway_id,
    )
    topic  = f"{MQTT_ROOT}/2/e/{channel_name}/{_gateway_id}"
    result = mq.publish(topic, envelope_bytes)
    status = "ok" if result.rc == mqtt.MQTT_ERR_SUCCESS else f"FAIL rc={result.rc}"
    print(f"[self] {status}  {portnum_name} → {topic}  ({len(envelope_bytes)}B)")


def _publish_self() -> None:
    """
    Publish our own node's NODEINFO, POSITION, and MAP_REPORT to MQTT.

    The local device doesn't echo its own radio transmissions back through
    meshtastic.receive, so we must push this data proactively on startup
    and periodically so the map keeps our node visible.
    """
    if not _mqtt_ready:
        return

    node_num = iface.localNode.nodeNum  # type: ignore[union-attr]
    my_id    = f"!{node_num:08x}"
    nodes    = iface.nodes or {}  # type: ignore[union-attr]
    my_node  = nodes.get(my_id, {})

    user_info = my_node.get("user", {})
    position  = my_node.get("position", {})

    # NODEINFO_APP
    if user_info:
        try:
            user_pb = ParseDict(user_info, mesh_pb2.User(), ignore_unknown_fields=True)
            _publish_packet("NODEINFO_APP", user_pb.SerializeToString(), "LongFast")
        except Exception as exc:
            print(f"[self] NODEINFO_APP error: {exc}")

    # POSITION_APP — only if we have a GPS fix
    if position and (position.get("latitudeI") or position.get("longitudeI")):
        try:
            pos_pb = ParseDict(position, mesh_pb2.Position(), ignore_unknown_fields=True)
            _publish_packet("POSITION_APP", pos_pb.SerializeToString(), "LongFast")
        except Exception as exc:
            print(f"[self] POSITION_APP error: {exc}")

    # MAP_REPORT_APP — published to the special "map" channel
    if MapReport is not None and user_info:
        try:
            has_default_ch = _channel_keys.get(0, b"") == DEFAULT_KEY
            report = MapReport(
                long_name=user_info.get("longName", ""),
                short_name=user_info.get("shortName", ""),
                hw_model=user_info.get("hwModel", 0),
                has_default_channel=has_default_ch,
                num_online_local_nodes=len(nodes),
            )
            if position.get("latitudeI"):
                report.latitude_i  = position["latitudeI"]
                report.longitude_i = position.get("longitudeI", 0)
                report.altitude    = position.get("altitude", 0)
            _publish_map_report(report.SerializeToString())
        except Exception as exc:
            print(f"[self] MAP_REPORT_APP error: {exc}")


# ---------------------------------------------------------------------------
# Packet handler
# ---------------------------------------------------------------------------

def on_receive(packet, interface):
    try:
        # Skip packets that arrived via MQTT downlink — re-publishing them
        # would create a feedback loop on a WiFi-capable gateway.
        if packet.get("viaMqtt", False):
            return

        from_num:   int  = packet.get("from", 0)
        to_num:     int  = packet.get("to", 0xFFFFFFFF)
        packet_id:  int  = packet.get("id", 0)
        ch_idx:     int  = packet.get("channel", 0)
        rx_time:    int  = int(packet.get("rxTime") or time.time())
        hop_limit:  int  = packet.get("hopLimit", 3)
        want_ack:   bool = bool(packet.get("wantAck", False))
        decoded:    dict = packet.get("decoded", {})
        portnum:    str  = decoded.get("portnum", "")

        payload_bytes = serialise_payload(decoded)
        if payload_bytes is None:
            return

        # Wrap payload in a Data protobuf
        try:
            portnum_int = portnums_pb2.PortNum.Value(portnum)
        except ValueError:
            portnum_int = 0

        data_bytes = mesh_pb2.Data(
            portnum=portnum_int,
            payload=payload_bytes,
        ).SerializeToString()

        # Re-encrypt using the channel key
        key = _channel_keys.get(ch_idx, DEFAULT_KEY)
        encrypted = encrypt_payload(key, packet_id, from_num, data_bytes)

        # MAP_REPORT_APP goes to 2/map/ as an unencrypted ServiceEnvelope
        if portnum in _MAP_CHANNEL_PORTNUMS:
            try:
                data_map      = mesh_pb2.Data(portnum=portnum_int, payload=payload_bytes)
                env_map_bytes = build_map_envelope(packet_id, from_num, data_map, _gateway_id)
                topic  = f"{MQTT_ROOT}/2/map/"
                result = mq.publish(topic, env_map_bytes)
                status = "ok" if result.rc == mqtt.MQTT_ERR_SUCCESS else f"FAIL rc={result.rc}"
                print(f"[pub] {status}  {portnum} from !{from_num:08x} → {topic}  ({len(env_map_bytes)}B)")
            except Exception as exc:
                print(f"[pub] MAP_REPORT_APP error: {exc}")
            return

        channel_name   = _channel_name(ch_idx)
        envelope_bytes = build_envelope(
            packet_id, from_num, to_num, ch_idx, rx_time,
            hop_limit, want_ack, encrypted, channel_name, _gateway_id,
        )

        # Topic: {root}/2/e/{channel}/{gateway_id}
        topic  = f"{MQTT_ROOT}/2/e/{channel_name}/{_gateway_id}"
        result = mq.publish(topic, envelope_bytes)
        status = "ok" if result.rc == mqtt.MQTT_ERR_SUCCESS else f"FAIL rc={result.rc}"
        print(f"[pub] {status}  {portnum} from !{from_num:08x} → {topic}  ({len(envelope_bytes)}B)")

    except Exception as exc:
        print(f"[on_receive] error: {exc}")
        traceback.print_exc()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

pub.subscribe(on_receive, "meshtastic.receive")

iface = meshtastic.serial_interface.SerialInterface(devPath=SERIAL_PORT or None)
_init_device()

print(f"Proxy running (gateway {_gateway_id}). Press Ctrl-C to stop.")
_last_self_pub = time.time()
try:
    while True:
        time.sleep(1)
        if time.time() - _last_self_pub >= SELF_PUB_INTERVAL:
            _publish_self()
            _last_self_pub = time.time()
except KeyboardInterrupt:
    pass
finally:
    mq.loop_stop()
    iface.close()
