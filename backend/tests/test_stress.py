"""Run: python -m unittest discover -s tests -p test_stress.py"""
import unittest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.stress import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)


class StressTests(unittest.TestCase):
    def payload(self, **changes):
        p = {"portfolioValue": 100000, "assets": [
            {"type": "stock", "id": "AAPL", "weight": 100,
             "currency": "USD", "priceShock": -15}], "fxShocks": {"USD": 10}}
        p.update(changes)
        return p

    def test_compounded_shocks(self):
        r = client.post('/api/stress', json=self.payload())
        self.assertEqual(r.status_code, 200)
        v = r.json()
        self.assertAlmostEqual(v['pnl'], -6500)
        self.assertAlmostEqual(v['stressedValue'], 93500)
        self.assertAlmostEqual(v['returnPct'], -6.5)
        self.assertAlmostEqual(v['pricePnl'] + v['fxPnl'] + v['interactionPnl'], v['pnl'])

    def test_mixed_weights_normalized(self):
        p = self.payload()
        p['assets'][0]['weight'] = 20
        p['assets'].append({'type':'fund','id':'NNF','weight':20,'currency':'TRY','priceShock':-20})
        v = client.post('/api/stress', json=p).json()
        self.assertAlmostEqual(v['pnl'], -13250)
        self.assertAlmostEqual(sum(a['pnl'] for a in v['assets']), v['pnl'])
        self.assertAlmostEqual(sum(a['weight'] for a in v['assets']), 1)

    def test_total_loss_and_no_shock(self):
        for shock, expected in [(-100,0),(0,100000)]:
            p = self.payload(fxShocks={'USD':0}); p['assets'][0]['priceShock'] = shock
            self.assertAlmostEqual(client.post('/api/stress', json=p).json()['stressedValue'], expected)

    def test_invalid_inputs(self):
        for key,value in [('weight',-1),('weight',0),('priceShock',-101),('currency','XYZ')]:
            with self.subTest(key=key,value=value):
                p=self.payload(); p['assets'][0][key]=value
                self.assertEqual(client.post('/api/stress',json=p).status_code,422)
        for changes in [{'fxShocks':{}},{'fxShocks':{'USD':-100}}, {'fxShocks':{'USD':0,'EUR':10}},
                        {'portfolioValue':0},{'assets':[]},{'unexpected':1}]:
            self.assertEqual(client.post('/api/stress',json=self.payload(**changes)).status_code,422)
        p=self.payload(); p['assets'] *= 2
        self.assertEqual(client.post('/api/stress',json=p).status_code,422)
        p=self.payload(); p['assets'][0]['type']='fund'
        self.assertEqual(client.post('/api/stress',json=p).status_code,422)

    def test_nonfinite_rejected(self):
        for val in ['NaN','Infinity','-Infinity']:
            import json
            p=self.payload(); p['portfolioValue']=val
            self.assertEqual(client.post('/api/stress',content=json.dumps(p),headers={'Content-Type':'application/json'}).status_code,422)


if __name__ == '__main__':
    unittest.main()
