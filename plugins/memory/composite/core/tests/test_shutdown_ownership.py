"""shutdown ownership: must NOT close a brain it does not own (M0-B1)."""

import pytest

from store import ExperienceStore
from plugins.memory.composite.core import CompositeMemoryProvider
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault


@pytest.fixture
def store():
    s = ExperienceStore(":memory:")
    yield s
    s.close()


def test_shutdown_does_not_close_handed_in_brain(store):
    brain = MockBrain()
    comp = CompositeMemoryProvider(store, brain=brain, vault=MockVault(), owns_brain=False)
    comp.initialize("s")
    comp.shutdown()
    assert brain.shutdown_called is False, "must not close a brain it does not own"


def test_shutdown_closes_owned_brain(store):
    brain = MockBrain()
    comp = CompositeMemoryProvider(store, brain=brain, vault=MockVault(), owns_brain=True)
    comp.initialize("s")
    comp.shutdown()
    assert brain.shutdown_called is True
