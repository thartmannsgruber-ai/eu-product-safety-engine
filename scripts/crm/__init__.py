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
    "BlacklistedRecipientError",
    "BlacklistManager",
    "is_blacklisted",
    "add_to_blacklist",
    "can_contact",
    "assert_can_contact",
    "CRMStorage",
    "LeadStatus",
    "VALID_LEAD_STATUSES",
    "get_lead",
    "update_lead_status",
    "list_leads",
    "init_from_campaign",
]
