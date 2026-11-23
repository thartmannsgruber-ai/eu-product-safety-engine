"""
scripts/tests/test_stripe_checkout.py
Unit-Tests fuer Stripe Checkout & B2B High-Ticket Audit Integration (Feature F08).
"""

from scripts.tests.test_crm_stripe_checkout import (
    TestStripeCheckoutPackagesAndMetadata,
    TestStripeWebhookAndOrderUnlocking,
    TestStripeCheckoutCLI,
)

if __name__ == "__main__":
    import unittest
    unittest.main()
