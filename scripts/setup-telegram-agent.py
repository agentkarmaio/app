#!/usr/bin/env python3
"""Inspect or bind @agentkarmabot without putting credentials in shell history."""
import argparse
import getpass
import json
import os
import re
import sys
import urllib.request
import warnings

WEBHOOK = "https://agentkarma.io/api/v2/telegram"
BOT = "agentkarmabot"


def credential(name, label):
    value = os.environ.get(name)
    if value:
        return value
    if not sys.stdin.isatty():
        raise RuntimeError(f"Run setup in an interactive terminal or supply {name} through the environment.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(label)
        except getpass.GetPassWarning:
            raise RuntimeError("Hidden terminal input is unavailable. Setup cancelled.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Register the reviewed webhook")
    args = parser.parse_args()
    token = credential("TELEGRAM_AGENT_BOT_TOKEN", "@agentkarmabot token (hidden): ")

    def api(method, body=None):
        request = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/{method}",
            data=json.dumps(body or {}).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                result = json.load(response)
            if result.get("ok") is not True:
                raise ValueError("API failure")
            return result["result"]
        except Exception:
            # Request URLs contain the credential. Do not print raw exceptions.
            raise RuntimeError(f"Telegram {method} failed; credentials and response details withheld.") from None

    me = api("getMe")
    if me.get("username", "").lower() != BOT or not me.get("is_bot"):
        raise RuntimeError("This token does not belong to @agentkarmabot. No changes made.")
    webhook = api("getWebhookInfo")
    existing = webhook.get("url", "")
    print(json.dumps({
        "bot": "@" + BOT,
        "webhook": "expected" if existing == WEBHOOK else "different" if existing else "not configured",
        "pending_updates": webhook.get("pending_update_count", 0),
        "last_error_present": bool(webhook.get("last_error_message")),
    }, indent=2))
    if not args.apply:
        print("Read-only inspection complete. Use --apply after the route and matching server secret are deployed.")
        return
    if existing and existing != WEBHOOK:
        raise RuntimeError("A different webhook already exists. Review that integration before replacing it; no changes made.")
    secret = credential("TELEGRAM_AGENT_WEBHOOK_SECRET", "Deployed TELEGRAM_AGENT_WEBHOOK_SECRET (hidden): ")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret):
        raise RuntimeError("Use a 32–256 character webhook secret containing only letters, digits, underscores, or hyphens.")
    # Preflight is non-delivering: an unrelated update is acknowledged but
    # never generates a chat message. It checks the deployed shared secret.
    probe = urllib.request.Request(WEBHOOK, data=b'{"update_id":0}', headers={
        "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret,
    })
    try:
        with urllib.request.urlopen(probe, timeout=20) as response:
            if json.load(response) != {"ok": True}:
                raise ValueError("Unexpected webhook response")
    except Exception:
        raise RuntimeError("Webhook preflight failed. Deploy the route and matching secret first; no Telegram changes made.") from None
    api("setWebhook", {"url": WEBHOOK, "secret_token": secret, "allowed_updates": ["message"], "max_connections": 1})
    print("Webhook registered. Open @agentkarmabot and verify /start and a reputation lookup in the chat.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, EOFError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Setup cancelled.", file=sys.stderr)
        sys.exit(1)
