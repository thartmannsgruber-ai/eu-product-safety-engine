#!/usr/bin/env python3
"""
Production-ready, rate-limited email dispatch script for the ProductSafetyEngine outreach campaign.
Supports --dry-run, --test-recipient, --country, --limit and automatic logging to prevent duplicates.
"""

import argparse
import datetime
import json
import os
import smtplib
import sys
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAMPAIGN_FILE = os.path.join(BASE_DIR, '.market', 'leads', 'outreach_campaign.json')
SENT_LOG_FILE = os.path.join(BASE_DIR, '.market', 'leads', 'sent_log.json')
ENV_FILE = os.path.join(BASE_DIR, '.env')

def load_env():
    env = {}
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

def create_message(sender_name, sender_email, to_email, subject, body):
    msg = MIMEMultipart('alternative')
    msg['From'] = f"{sender_name} <{sender_email}>"
    msg['To'] = to_email
    msg['Subject'] = subject
    msg['Date'] = datetime.datetime.now(datetime.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S %z')
    msg['Reply-To'] = sender_email
    
    # Plain text version (essential for mobile & deliverability)
    part_text = MIMEText(body, 'plain', 'utf-8')
    msg.attach(part_text)
    
    return msg

def main():
    parser = argparse.ArgumentParser(description="Send outreach emails for ProductSafetyEngine leads.")
    parser.add_argument('--dry-run', action='store_true', default=False, help="Simulate send without connecting to SMTP.")
    parser.add_argument('--send', action='store_true', default=False, help="Perform actual SMTP transmission.")
    parser.add_argument('--test-recipient', type=str, default=None, help="Send a single test email to this address.")
    parser.add_argument('--country', type=str, default=None, help="Filter leads by country (e.g. Netherlands, France).")
    parser.add_argument('--limit', type=int, default=None, help="Max number of emails to send in this run.")
    parser.add_argument('--delay', type=int, default=60, help="Delay between emails in seconds (default: 60s).")
    
    args = parser.parse_args()
    
    if not args.dry_run and not args.send and not args.test_recipient:
        print("[INFO] No action specified. Defaulting to --dry-run mode.")
        args.dry_run = True

    env = load_env()
    smtp_host = os.environ.get('SMTP_HOST') or env.get('SMTP_HOST')
    smtp_port = int(os.environ.get('SMTP_PORT') or env.get('SMTP_PORT', 587))
    smtp_user = os.environ.get('SMTP_USER') or env.get('SMTP_USER', 'info@thfc-consulting.de')
    smtp_pass = os.environ.get('SMTP_PASS') or env.get('SMTP_PASS')
    sender_name = os.environ.get('SENDER_NAME') or env.get('SENDER_NAME', 'Thomas | THFC Consulting')
    sender_email = smtp_user
    
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
    print(f"Sender: {sender_name} <{sender_email}>")
    print(f"Mode: {'TEST TO ' + args.test_recipient if args.test_recipient else ('LIVE SEND' if args.send else 'DRY RUN')}")
    print("=========================================\n")
    
    if args.test_recipient:
        if not smtp_host or not smtp_pass:
            print("[ERROR] SMTP_HOST and SMTP_PASS must be configured in .env or environment to send a test email.")
            sys.exit(1)
        test_lead = queue[0] if queue else campaign[0]
        print(f"Sending test preview of lead '{test_lead['company']}' to {args.test_recipient}...")
        msg = create_message(sender_name, sender_email, args.test_recipient, f"[TEST PREVIEW] {test_lead['subject']}", test_lead['body'])
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        print("[SUCCESS] Test email successfully delivered!")
        return

    if args.dry_run:
        for idx, lead in enumerate(queue, 1):
            print(f"[{idx}/{len(queue)}] DRY RUN -> To: {lead['email']} | Co: {lead['company']} ({lead['country']})")
            print(f"    Subject: {lead['subject']}")
            print(f"    Focus: {lead['detected_focus']}")
            print("-" * 50)
        print(f"\n[SUMMARY] Dry run completed for {len(queue)} emails. Zero emails were sent.")
        print("To send live emails, configure .env with SMTP credentials and run with --send.")
        return

    if args.send:
        if not smtp_host or not smtp_pass:
            print("[ERROR] SMTP_HOST and SMTP_PASS are missing in .env or environment!")
            print("Please create .env with:")
            print("  SMTP_HOST=your-smtp-server.com")
            print("  SMTP_PORT=587")
            print("  SMTP_USER=info@thfc-consulting.de")
            print("  SMTP_PASS=your-app-password")
            sys.exit(1)
            
        print(f"Connecting to SMTP server {smtp_host}:{smtp_port}...")
        server = smtplib.SMTP(smtp_host, smtp_port)
        server.starttls()
        server.login(smtp_user, smtp_pass)
        print("Authenticated successfully!\n")
        
        sent_count = 0
        try:
            for idx, lead in enumerate(queue, 1):
                to_addr = lead['email']
                print(f"[{idx}/{len(queue)}] Sending to {to_addr} ({lead['company']})...")
                msg = create_message(sender_name, sender_email, to_addr, lead['subject'], lead['body'])
                server.send_message(msg)
                
                sent_log[to_addr] = {
                    'sent_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
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
