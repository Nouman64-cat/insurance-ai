import pandas as pd

death_path = '/run/media/zain-ali/New Volume/insurance/pds_data/SPSS-Data/SPSS Data/SPSS Data/Death.sav'
roster_path = '/run/media/zain-ali/New Volume/insurance/pds_data/SPSS-Data/SPSS Data/SPSS Data/Roster.sav'

try:
    print("Reading Death.sav...")
    df_death = pd.read_spss(death_path)
    print("Death columns:", df_death.columns.tolist())
    print("Death head:\n", df_death.head())
    
    print("\nReading Roster.sav...")
    df_roster = pd.read_spss(roster_path)
    print("Roster columns:", df_roster.columns.tolist())
    print("Roster head:\n", df_roster.head())
except Exception as e:
    print("Error:", e)
