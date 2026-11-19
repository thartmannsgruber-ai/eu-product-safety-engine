"""
scripts/tests/test_crm_cli_dispatcher.py
Alias / wrapper for test_crm_dispatcher_cli.py to satisfy both naming conventions.
"""

from scripts.tests.test_crm_dispatcher_cli import TestCRMDispatcherAndCLI

if __name__ == "__main__":
    import unittest
    unittest.main()
