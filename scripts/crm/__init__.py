"""
scripts/crm/__init__.py
ProductSafetyEngine CRM & Inbound Mail-Crawler Package.
"""

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    add_to_blacklist,
    assert_can_contact,
    can_contact,
    is_blacklisted,
)
from scripts.crm.classifier import (
    ClassificationResult,
    Intent,
    VALID_INTENTS,
    classify_intent,
    extract_eans,
    strip_quoted_reply,
)
from scripts.crm.crawler import (
    InboundMailCrawler,
    clean_subject_prefix,
    decode_mime_header,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    VALID_LEAD_STATUSES,
    get_lead,
    init_from_campaign,
    list_leads,
    update_lead_status,
)

__all__ = [
    # Blacklist
    "BlacklistedRecipientError",
    "BlacklistManager",
    "is_blacklisted",
    "add_to_blacklist",
    "can_contact",
    "assert_can_contact",
    # Storage
    "CRMStorage",
    "LeadStatus",
    "VALID_LEAD_STATUSES",
    "get_lead",
    "update_lead_status",
    "list_leads",
    "init_from_campaign",
    # Classifier
    "Intent",
    "VALID_INTENTS",
    "ClassificationResult",
    "classify_intent",
    "extract_eans",
    "strip_quoted_reply",
    # Crawler
    "InboundMailCrawler",
    "clean_subject_prefix",
    "decode_mime_header",
]
