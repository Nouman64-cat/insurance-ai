import pandas as pd

death_path = '/run/media/zain-ali/New Volume/insurance/pds_data/SPSS-Data/SPSS Data/SPSS Data/Death.sav'
roster_path = '/run/media/zain-ali/New Volume/insurance/pds_data/SPSS-Data/SPSS Data/SPSS Data/Roster.sav'

df_death = pd.read_spss(death_path)
df_roster = pd.read_spss(roster_path)

# Normalize Gender to 1 (Male) and 2 (Female)
df_death['sex'] = df_death['GENDER'].str.lower().map({'male': 1, 'female': 2})
df_roster['sex'] = df_roster['GENDER'].str.lower().map({'male': 1, 'female': 2})

def get_age_band(age):
    if pd.isna(age): return 'Unknown'
    if age < 50: return '<50'
    elif age < 55: return '50-54'
    elif age < 65: return '55-64'
    elif age < 75: return '65-74'
    else: return '75+'

df_death['age_band'] = df_death['AGE_AT_DEATH'].apply(get_age_band)
df_roster['age_band'] = df_roster['AGE_IN_YEARS'].apply(get_age_band)

# Aggregate deaths and population
deaths = df_death.groupby(['age_band', 'sex']).size()
pop = df_roster.groupby(['age_band', 'sex']).size()

# The survey covers 3 years (2018-2020), so we divide deaths by 3 to get annual average
annual_deaths = deaths / 3.0

# Calculate qx (probability of death in 1 year)
qx = annual_deaths / pop
df_qx = qx.reset_index(name='pakistan_qx')

# Filter out 'Unknown' age_band
df_qx = df_qx[df_qx['age_band'] != 'Unknown'].copy()
df_qx['source'] = 'PDS_2020_ACTUAL'

print(df_qx)

# Now, we will output this as python code to insert into pakistan_calibration.py
records = df_qx.to_dict(orient='records')
print("\nNew pds_data list for pakistan_calibration.py:")
print("pds_data = [")
for r in records:
    print(f"    {{'age_band': '{r['age_band']}', 'sex': {r['sex']:.0f}, 'pakistan_qx': {r['pakistan_qx']:.5f}, 'source': '{r['source']}'}},")
print("]")
