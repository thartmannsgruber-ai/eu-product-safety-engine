#!/usr/bin/env python3
"""
Production-ready email dispatch script for ProductSafetyEngine outreach campaign.
Supports:
1. Microsoft 365 Exchange Online (SMTP via smtp.office365.com:587)
2. Resend API (via THFC system.thfc-consulting.de with Reply-To: info@thfc-consulting.de)
3. --dry-run, --test-recipient, --country, --limit, rate-limiting and duplicate prevention.
"""

import argparse
import datetime
import json
import os
import smtplib
import sys
import time
import urllib.request
import urllib.error
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAMPAIGN_FILE = os.path.join(BASE_DIR, '.market', 'leads', 'outreach_campaign.json')
SENT_LOG_FILE = os.path.join(BASE_DIR, '.market', 'leads', 'sent_log.json')
ENV_FILE = os.path.join(BASE_DIR, '.env')

# Paths
THFC_ENV_FILE = "/mnt/devstorage/projects/THFC/SmartBetaFaktorEngine/.env.local"

def load_env():
    env = {}
    # First check neighboring THFC workspace if present
    if os.path.exists(THFC_ENV_FILE):
        with open(THFC_ENV_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('\'"')
    # Then overlay local .env
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('\'"')
    return env

def load_sent_log():
    if os.path.exists(SENT_LOG_FILE):
        try:
            with open(SENT_LOG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_sent_log(log_data):
    with open(SENT_LOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(log_data, f, indent=2, ensure_ascii=False)

def create_mime_message(sender_name, sender_email, to_email, subject, body, reply_to="info@thfc-consulting.de"):
    msg = MIMEMultipart('alternative')
    msg['From'] = f"{sender_name} <{sender_email}>"
    msg['To'] = to_email
    msg['Subject'] = subject
    msg['Date'] = datetime.datetime.now(datetime.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S %z')
    msg['Reply-To'] = reply_to
    
    part_text = MIMEText(body, 'plain', 'utf-8')
    msg.attach(part_text)
    return msg

def send_via_resend(api_key, from_email, to_email, subject, body, reply_to="info@thfc-consulting.de"):
    url = "https://api.resend.com/emails"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    payload = {
        "from": from_email,
        "to": [to_email],
        "reply_to": reply_to,
        "subject": subject,
        "text": body
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        return res

def main():
    parser = argparse.ArgumentParser(description="Send outreach emails for ProductSafetyEngine leads.")
    parser.add_argument('--dry-run', action='store_true', default=False, help="Simulate send without connecting.")
    parser.add_argument('--send', action='store_true', default=False, help="Perform actual live email transmission.")
    parser.add_argument('--provider', choices=['exchange', 'resend'], default='resend', help="Provider to use: 'exchange' (SMTP) or 'resend' (API). Default: resend")
    parser.add_argument('--test-recipient', type=str, default=None, help="Send a single test preview to this address.")
    parser.add_argument('--country', type=str, default=None, help="Filter leads by country (e.g. Netherlands, France).")
    parser.add_argument('--limit', type=int, default=None, help="Max number of emails to send in this run.")
    parser.add_argument('--delay', type=int, default=60, help="Delay between emails in seconds (default: 60s).")
    
    args = parser.parse_args()
    
    if not args.dry_run and not args.send and not args.test_recipient:
        print("[INFO] No action specified. Defaulting to --dry-run mode.")
        args.dry_run = True

    env = load_env()
    
    # Provider Settings
    resend_key = os.environ.get('RESEND_API_KEY') or env.get('RESEND_API_KEY')
    resend_from = env.get('RESEND_FROM', 'Thomas | THFC Consulting <leads@system.thfc-consulting.de>')
    
    smtp_host = os.environ.get('SMTP_HOST') or env.get('SMTP_HOST', 'smtp.office365.com')
    smtp_port = int(os.environ.get('SMTP_PORT') or env.get('SMTP_PORT', 587))
    smtp_user = os.environ.get('SMTP_USER') or env.get('SMTP_USER', 'thomas@thfc-consulting.de')
    smtp_pass = os.environ.get('SMTP_PASS') or env.get('SMTP_PASS')
    
    sender_name = os.environ.get('SENDER_NAME') or env.get('SENDER_NAME', 'Thomas | THFC Consulting')
    reply_to = "info@thfc-consulting.de"
    
    if not os.path.exists(CAMPAIGN_FILE):
        print(f"[ERROR] Campaign file not found: {CAMPAIGN_FILE}")
        sys.exit(1)
        
    with open(CAMPAIGN_FILE, 'r', encoding='utf-8') as f:
        campaign = json.load(f)
        
    sent_log = load_sent_log()
    
    # Filter
    queue = []
    for lead in campaign:
        if not lead.get('email'):
            continue
        if args.country and lead.get('country', '').lower() != args.country.lower():
            continue
        if lead['email'] in sent_log and not args.test_recipient:
            continue
        queue.append(lead)
        
    if args.limit:
        queue = queue[:args.limit]
        
    print(f"=== ProductSafetyEngine Lead Outreach ===")
    print(f"Target Leads in Queue: {len(queue)}")
    print(f"Provider: {args.provider.upper()}")
    if args.provider == 'resend':
        print(f"From: {resend_from} (Reply-To: {reply_to})")
    else:
        print(f"From: {sender_name} <{smtp_user}> (SMTP: {smtp_host}:{smtp_port})")
    print(f"Mode: {'TEST TO ' + args.test_recipient if args.test_recipient else ('LIVE SEND' if args.send else 'DRY RUN')}")
    print("=========================================\n")
    
    if args.test_recipient:
        test_lead = queue[0] if queue else campaign[0]
        test_subj = f"[TEST PREVIEW] {test_lead['subject']}"
        print(f"Sending test preview for lead '{test_lead['company']}' to {args.test_recipient}...")
        
        if args.provider == 'resend':
            res = send_via_resend(resend_key, resend_from, args.test_recipient, test_subj, test_lead['body'], reply_to=reply_to)
            print(f"[SUCCESS] Delivered via Resend! ID: {res.get('id')}")
        else:
            if not smtp_pass:
                print("[ERROR] SMTP_PASS must be set in .env for Exchange SMTP!")
                sys.exit(1)
            msg = create_mime_message(sender_name, "info@thfc-consulting.de", args.test_recipient, test_subj, test_lead['body'], reply_to=reply_to)
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
            print("[SUCCESS] Delivered via Microsoft 365 Exchange SMTP!")
        return

    if args.dry_run:
        for idx, lead in enumerate(queue, 1):
            print(f"[{idx}/{len(queue)}] DRY RUN -> To: {lead['email']} | Co: {lead['company']} ({lead['country']})")
            print(f"    Subject: {lead['subject']}")
            print(f"    Focus: {lead['detected_focus']}")
            print("-" * 50)
        print(f"\n[SUMMARY] Dry run completed for {len(queue)} emails. Zero emails were sent.")
        print(f"Ready to send! Run with --send --provider {args.provider}")
        return

    if args.send:
        sent_count = 0
        if args.provider == 'resend':
            print("Connecting to Resend API...")
            for idx, lead in enumerate(queue, 1):
                to_addr = lead['email']
                print(f"[{idx}/{len(queue)}] Sending via Resend to {to_addr} ({lead['company']})...")
                res = send_via_resend(resend_key, resend_from, to_addr, lead['subject'], lead['body'], reply_to=reply_to)
                
                sent_log[to_addr] = {
                    'sent_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'provider': 'resend',
                    'resend_id': res.get('id'),
                    'company': lead['company'],
                    'country': lead['country'],
                    'subject': lead['subject']
                }
                save_sent_log(sent_log)
                sent_count += 1
                print(f"    [SENT: {res.get('id')}] Waiting {args.delay}s delay...")
                if idx < len(queue):
                    time.sleep(args.delay)
        else: # Exchange SMTP
            if not smtp_pass:
                print("[ERROR] SMTP_PASS is missing in .env for Exchange!")
                sys.exit(1)
            print(f"Connecting to Microsoft 365 SMTP ({smtp_host}:{smtp_port})...")
            server = smtplib.SMTP(smtp_host, smtp_port)
            server.starttls()
            server.login(smtp_user, smtp_pass)
            print("Authenticated successfully!\n")
            try:
                for idx, lead in enumerate(queue, 1):
                    to_addr = lead['email']
                    print(f"[{idx}/{len(queue)}] Sending via Exchange to {to_addr} ({lead['company']})...")
                    msg = create_mime_message(sender_name, "info@thfc-consulting.de", to_addr, lead['subject'], lead['body'], reply_to=reply_to)
                    server.send_message(msg)
                    
                    sent_log[to_addr] = {
                        'sent_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        'provider': 'exchange',
                        'company': lead['company'],
                        'country': lead['country'],
                        'subject': lead['subject']
                    }
                    save_sent_log(sent_log)
                    sent_count += 1
                    print(f"    [SENT] Waiting {args.delay}s delay...")
                    if idx < len(queue):
                        time.sleep(args.delay)
            finally:
                server.quit()
                
        print(f"\n[COMPLETE] Successfully dispatched {sent_count} outreach emails.")

if __name__ == '__main__':
    main()
