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
from scripts.crm.engine_runner import (
    AuditHit,
    AuditItem,
    AuditResult,
    AuditRunReport,
    SafetyGateEngine,
    extract_from_csv,
    extract_from_email_or_attachments,
    extract_gtins_and_products,
    normalize_to_gtin14,
    validate_gtin_checksum,
)
from scripts.crm.report_generator import (
    STANDARD_DISCLAIMER_TEMPLATE,
    ZERO_HITS_NOTE,
    format_safety_gate_date,
    generate_markdown_report,
    generate_report,
    generate_text_report,
    get_standard_disclaimer,
    get_zero_hits_note,
)
from scripts.crm.review_queue import (
    ALLOWED_TRANSITIONS,
    DraftNotFoundError,
    DraftStatus,
    InvalidStatusTransitionError,
    ReviewQueue,
    VALID_DRAFT_STATUSES,
    get_default_queue,
    set_default_queue,
)
from scripts.crm.drafter import (
    APIFY_ACTOR_URL,
    ResponseDraft,
    ResponseDrafter,
    draft_and_enqueue,
    draft_response,
    get_default_drafter,
    normalize_language_code,
)
from scripts.crm.dispatcher import (
    DispatchResult,
    EmailDispatcher,
    UnapprovedDraftError,
    dispatch_approved_drafts,
    dispatch_draft,
    get_default_dispatcher,
    set_default_dispatcher,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    VALID_LEAD_STATUSES,
    cleanup_leads_db,
    get_lead,
    init_from_campaign,
    list_leads,
    sanitize_leads,
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
    "sanitize_leads",
    "cleanup_leads_db",
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
    # Engine Runner
    "AuditHit",
    "AuditItem",
    "AuditResult",
    "AuditRunReport",
    "SafetyGateEngine",
    "extract_gtins_and_products",
    "extract_from_csv",
    "extract_from_email_or_attachments",
    "normalize_to_gtin14",
    "validate_gtin_checksum",
    # Report Generator
    "STANDARD_DISCLAIMER_TEMPLATE",
    "ZERO_HITS_NOTE",
    "format_safety_gate_date",
    "get_standard_disclaimer",
    "get_zero_hits_note",
    "generate_report",
    "generate_text_report",
    "generate_markdown_report",
    # Review Queue (HITL)
    "DraftStatus",
    "VALID_DRAFT_STATUSES",
    "ALLOWED_TRANSITIONS",
    "DraftNotFoundError",
    "InvalidStatusTransitionError",
    "ReviewQueue",
    "get_default_queue",
    "set_default_queue",
    # Drafter
    "APIFY_ACTOR_URL",
    "ResponseDraft",
    "ResponseDrafter",
    "draft_response",
    "draft_and_enqueue",
    "get_default_drafter",
    "normalize_language_code",
    # Dispatcher
    "EmailDispatcher",
    "DispatchResult",
    "UnapprovedDraftError",
    "dispatch_draft",
    "dispatch_approved_drafts",
    "get_default_dispatcher",
    "set_default_dispatcher",
]
