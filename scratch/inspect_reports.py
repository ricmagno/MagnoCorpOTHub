import sqlite3
import json

db_path = 'data/reports.db'

def run():
    print(f"Connecting to {db_path}...")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, name, description, config FROM reports")
    rows = cursor.fetchall()
    
    found = 0
    for row in rows:
        r_id, name, desc, config_str = row
        if 'Kagome_AU.BR_WQ001_PV' in config_str or 'Beet' in name:
            found += 1
            print(f"\nFound report: {name} (ID: {r_id})")
            print(f"Description: {desc}")
            try:
                config = json.loads(config_str)
                print("Config:", json.dumps(config, indent=2))
            except Exception as e:
                print("Raw Config:", config_str)
                
    if found == 0:
        print("No reports referencing Kagome_AU.BR_WQ001_PV or Beet found.")
    else:
        print(f"\nFound {found} matching reports.")
        
    conn.close()

if __name__ == '__main__':
    run()
