from src.inference import PakistaniMortalityRiskPredictor, ApplicantProfile
p = PakistaniMortalityRiskPredictor('5yr', 'xgboost', Z=0.85)
a = ApplicantProfile(1, 1974, 50.0, 0, 1, 3, 10, 10000, 50000, 10000, 30000, 0, 5, 24.5, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1)
res = p.predict(a)
print("Raw:", res['raw_percent'])
print("Cal:", res['percent'])
print("Bucket avg:", res['bucket_model_avg'])
print("Bucket pk:", res['bucket_pakistan_qx'])
