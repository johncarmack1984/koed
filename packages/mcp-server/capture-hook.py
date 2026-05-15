#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import pathlib
import sys
import urllib.request


def stable_hash(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def stringify(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return ""


def actor_from(record):
    message = record.get("message") if isinstance(record.get("message"), dict) else {}
    for value in (record.get("role"), message.get("role"), record.get("actor")):
        if value in ("user", "assistant", "tool", "system"):
            return value
    if record.get("type") == "user_message":
        return "user"
    if record.get("type") in ("assistant_message", "agent_message"):
        return "assistant"
    return None


def parse_transcript(transcript_path):
    path = pathlib.Path(transcript_path)
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    records = []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            records.extend(parsed)
        elif isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
            records.extend(parsed["items"])
        else:
            records.append(parsed)
    except Exception:
        for line in text.splitlines():
            try:
                records.append(json.loads(line))
            except Exception:
                pass

    prefer_event_messages = any(
        isinstance(record, dict)
        and record.get("type") == "event_msg"
        and isinstance(record.get("payload"), dict)
        and record["payload"].get("type")
        in ("user_message", "agent_message", "assistant_message")
        for record in records
    )

    items = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        source = record.get("payload") if isinstance(record.get("payload"), dict) else record
        if (
            prefer_event_messages
            and record.get("type") == "response_item"
            and source.get("type") == "message"
        ):
            continue
        message = source.get("message") if isinstance(source.get("message"), dict) else {}
        actor = actor_from(source)
        content = stringify(
            source.get("content")
            or source.get("text")
            or (source.get("message") if isinstance(source.get("message"), str) else None)
            or message.get("content")
            or message.get("text")
        )
        if actor and content.strip():
            items.append(
                {
                    "actor": actor,
                    "eventType": f"codex_transcript_{actor}",
                    "content": content,
                    "metadata": {
                        "transcriptIndex": index,
                        "transcriptType": source.get("type"),
                        "transcriptParentType": record.get("type"),
                        "transcriptId": source.get("id"),
                    },
                }
            )
    return items


def fallback_items(payload):
    metadata = {
        "hookEventName": payload.get("hook_event_name"),
        "externalSessionId": payload.get("session_id"),
        "externalTurnId": payload.get("turn_id"),
        "model": payload.get("model"),
        "cwd": payload.get("cwd"),
    }
    if payload.get("prompt"):
        return [
            {
                "actor": "user",
                "eventType": "codex_user_prompt",
                "content": payload["prompt"],
                "metadata": metadata,
            }
        ]
    if payload.get("last_assistant_message"):
        return [
            {
                "actor": "assistant",
                "eventType": "codex_assistant_message",
                "content": payload["last_assistant_message"],
                "metadata": metadata,
            }
        ]
    if payload.get("tool_name"):
        return [
            {
                "actor": "tool",
                "eventType": "codex_tool_result",
                "content": stringify(
                    {
                        "toolInput": payload.get("tool_input"),
                        "toolResponse": payload.get("tool_response"),
                    }
                ),
                "metadata": {**metadata, "toolName": payload.get("tool_name")},
            }
        ]
    return []


def post_event(config, payload):
    url = config["apiUrl"].rstrip("/") + "/v1/memory/capture-personal-event"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {config['apiToken']}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        response.read()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        default=str(pathlib.Path.home() / ".codex-memory" / "config.json"),
        help="Path to JSON config with apiUrl and apiToken.",
    )
    parser.add_argument(
        "--state",
        default=str(pathlib.Path.home() / ".codex-memory" / "capture-state.json"),
        help="Path to local dedupe state.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    config_path = pathlib.Path(args.config).expanduser()
    state_path = pathlib.Path(args.state).expanduser()
    payload = json.loads(sys.stdin.read() or "{}")
    config = read_json(config_path, {})
    if not config.get("apiUrl") or not config.get("apiToken"):
        raise RuntimeError("Memory API config is missing apiUrl or apiToken")
    if config.get("captureEnabled") is False:
        print("codex-memory python capture hook skipped because capture is paused", file=sys.stderr)
        return

    transcript_items = (
        parse_transcript(payload["transcript_path"])
        if payload.get("transcript_path")
        else []
    )
    items = transcript_items or fallback_items(payload)
    state = read_json(state_path, {"seen": {}})
    seen = state.setdefault("seen", {})
    workspace_id = payload.get("cwd") or "default"
    captured = 0

    for item in items:
        item_hash = stable_hash(
            {
                "session": payload.get("session_id"),
                "turn": payload.get("turn_id"),
                "item": item,
            }
        )
        if seen.get(item_hash):
            continue
        post_event(
            config,
            {
                "workspaceId": workspace_id,
                "actor": item["actor"],
                "eventType": item["eventType"],
                "content": item["content"],
                "metadata": {
                    **item.get("metadata", {}),
                    "hookEventName": payload.get("hook_event_name"),
                    "externalSessionId": payload.get("session_id"),
                    "externalTurnId": payload.get("turn_id"),
                    "sourceHash": item_hash,
                    "automaticCaptureScope": "personal",
                    "captureHookRuntime": "python",
                },
            },
        )
        seen[item_hash] = True
        captured += 1

    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    limited = dict(list(seen.items())[-5000:])
    state_path.write_text(json.dumps({"seen": limited}, indent=2), encoding="utf-8")
    os.chmod(state_path, 0o600)
    print(
        f"codex-memory python capture hook stored {captured} personal event(s)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
