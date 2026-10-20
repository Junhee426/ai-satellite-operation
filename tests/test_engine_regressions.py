import numpy as np
import pytest

from engine import FIELDS, current_snapshot, snapshot, telemetry
from main import SimulationRequest


@pytest.mark.parametrize('elapsed', [
    0, .001, .049, 29.999, 30, 59.995, 1199.999,
    1200, 1200.001, 1234.56789, 86399.999, 86400,
])
def test_history_preserves_time_and_never_samples_the_future(elapsed):
    result = snapshot(SimulationRequest(elapsed=elapsed))
    times = [point['time'] for point in result['history']]
    assert times[-1] == elapsed
    assert all(max(0, elapsed - 1200) <= time <= elapsed for time in times)
    assert all(left < right for left, right in zip(times, times[1:]))
    assert result['history'][-1]['values'] == result['selected']['telemetry']
    assert result['history'][-1]['capacity'] == result['selected']['capacity']
    assert result['history'][-1]['risk'] == result['selected']['risk']


def test_scheduled_fault_does_not_leak_into_history_just_before_start():
    fault = {'id': 'future', 'satellite': 0, 'kind': 'thermal', 'at': 30}
    before = snapshot(SimulationRequest(elapsed=29.999, faults=[fault]))
    nominal = snapshot(SimulationRequest(elapsed=29.999))
    assert before['history'] == nominal['history']
    assert before['history'][-1]['time'] == 29.999
    at_start = snapshot(SimulationRequest(elapsed=30, faults=[fault]))
    assert at_start['history'][-1]['values']['temperature'] > 48


def branch_request(elapsed=1500):
    return SimulationRequest(
        config={'planes': 4, 'per_plane': 16},
        elapsed=elapsed,
        selected=37,
        seed=117,
        faults=[
            {'id': 'thermal', 'satellite': 37, 'kind': 'thermal', 'at': 180},
            {'id': 'cpu', 'satellite': 37, 'kind': 'cpu', 'at': 300},
            {'id': 'link', 'satellite': 4, 'kind': 'link', 'at': 120},
        ],
        actions=[
            {'fault_id': 'thermal', 'kind': 'payload_throttle', 'at': 600},
            {'fault_id': 'cpu', 'kind': 'computer_restart', 'at': 1200},
        ],
    )


def test_current_snapshot_matches_full_snapshot_without_optional_series():
    request = branch_request()
    current = current_snapshot(request)
    full = snapshot(request)
    assert 'history' not in current
    assert 'track' not in current
    assert current == {key: value for key, value in full.items()
                       if key not in ('history', 'track')}


@pytest.mark.parametrize('elapsed', [0, 9.999, 10, 600, 1200, 1289.999, 1290, 1500])
def test_selected_telemetry_keeps_constellation_noise_and_action_effects(elapsed):
    request = branch_request(elapsed)
    selected = [37, 4, 0, 63]
    for apply_actions in (True, False):
        all_values, all_capacity = telemetry(request, elapsed, apply_actions=apply_actions)
        values, capacity = telemetry(request, elapsed, selected, apply_actions=apply_actions)
        np.testing.assert_array_equal(values, all_values[selected])
        np.testing.assert_array_equal(capacity, all_capacity[selected])


def test_history_branches_match_independent_telemetry_without_shared_mutation():
    request = branch_request()
    result = snapshot(request)
    for point in result['history']:
        for values_key, capacity_key, apply_actions in (
            ('values', 'capacity', True),
            ('unmitigated', 'unmitigated_capacity', False),
        ):
            values, capacity = telemetry(
                request, point['time'], [request.selected], apply_actions=apply_actions,
            )
            expected = {field: round(float(value), 3)
                        for field, value in zip(FIELDS, values[0])}
            assert point[values_key] == expected
            assert point[capacity_key] == round(float(capacity[0]) * 100, 1)
    assert result['history'][-1]['values'] != result['history'][-1]['unmitigated']
