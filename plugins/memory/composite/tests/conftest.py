"""Composite memory provider test conftest — no AIOS path injection needed.

With M0-B3 the provider imports natively from .core and .experience_store.
Tests import directly from plugins.memory.composite.* — no sys.path manipulation required.
"""
