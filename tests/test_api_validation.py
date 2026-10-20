import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture(scope='module')
def client():
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.mark.parametrize('path', ['/api/simulate', '/api/export'])
@pytest.mark.parametrize('body', [
    '{"elapsed":NaN}',
    '{"elapsed":Infinity}',
    '{"elapsed":-Infinity}',
    '{"elapsed":1e309}',
    '{"config":{"altitude":NaN}}',
    '{"selected":Infinity}',
    '{"faults":[{"id":"f1","satellite":0,"kind":"thermal","at":NaN}]}',
    '{"unexpected":{"value":NaN}}',
    '1e309',
])
def test_nonfinite_input_returns_json_validation_error(client, path, body):
    response = client.post(path, content=body, headers={'content-type': 'application/json'})
    assert response.status_code == 422
    details = response.json()['detail']
    assert details
    assert all({'type', 'loc', 'msg'} <= error.keys() for error in details)
    assert all('input' not in error and 'ctx' not in error for error in details)


def test_reference_validation_keeps_field_and_message_details(client):
    response = client.post('/api/simulate', json={'config': {'planes': 1, 'phasing': 1}})
    assert response.status_code == 422
    error = response.json()['detail'][0]
    assert error['loc'] == ['body', 'config']
    assert 'Walker F' in error['msg']
