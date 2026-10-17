import pandas as pd
import numpy as np
import os
import xgboost as xgb
import shap
from sklearn.feature_selection import mutual_info_classif
from sklearn.feature_selection import VarianceThreshold
from statsmodels.stats.outliers_influence import variance_inflation_factor
from statsmodels.tools.tools import add_constant
import warnings

warnings.filterwarnings('ignore')

def main():
    print("--- Starting Phase 5: Feature Selection ---")
    
    # 1. Setup Paths
    base_dir = "/run/media/zain-ali/New Volume/insurance/project"
    features_path = os.path.join(base_dir, "data", "processed", "phase4_imputed_features.parquet")
    # Note: Adjust this path/filename if your Phase 1 labels were named differently!
    labels_path = os.path.join(base_dir, "data", "processed", "phase1_mortality_labels.parquet") 
    output_features_path = os.path.join(base_dir, "data", "processed", "phase5_selected_features.parquet")
    report_path = os.path.join(base_dir, "reports", "feature_selection_rationale.md")
    
    # 2. Load and Join Data
    print(f"Loading imputed features from: {features_path}")
    df_features = pd.read_parquet(features_path)
    print(f"Loading mortality labels from: {labels_path}")
    df_labels = pd.read_parquet(labels_path)
    
    # Inner join to ensure we only have valid rows with both features and labels
    # Merge on all shared metadata to prevent _x/_y suffixes
    shared_cols = ['hhidpn', 'entry_wave', 'entry_year', 'cohort_ahead_1995']
    df = pd.merge(df_features, df_labels, on=shared_cols, how='inner')
    print(f"Joined dataset size: {len(df)} rows.")
    
    # Identify the target column (Looking for a binary 5-year or 10-year mortality flag)
    # Assuming standard names like 'died_in_5_years' or 'died_within_10yrs'
    target_cols = [c for c in df.columns if 'died' in c.lower() or 'death_within' in c.lower() or '5yr' in c.lower() or '10yr' in c.lower()]
    target_cols = [c for c in target_cols if set(df[c].dropna().unique()).issubset({0, 1, 0.0, 1.0})]
    
    if not target_cols:
        raise ValueError("Could not auto-detect a binary mortality target column from Phase 1 labels. Please specify manually.")
    
    target_col = target_cols[0] # Pick the first valid binary horizon (e.g., 5-year or 10-year)
    print(f"Using '{target_col}' as the target for feature ranking.")
    
    # Drop NaNs in target (censored cases that couldn't be resolved for this specific horizon)
    df = df.dropna(subset=[target_col])
    
    # NEW FIX: Isolate audit variables (e.g. race) into a separate file before selection
    audit_cols = ['hhidpn', 'race'] if 'race' in df.columns else ['hhidpn']
    audit_df = df[audit_cols]
    audit_path = os.path.join(base_dir, "data", "processed", "phase5_audit_set.parquet")
    audit_df.to_parquet(audit_path, index=False)
    print(f"Saved audit set (n={len(audit_df)}) to: {audit_path}")
    
    # NEW FIX: Time-based Train/Test Split (80/20) BEFORE feature selection
    # Sort by entry_year and hhidpn to ensure stable chronological split
    df = df.sort_values(by=['entry_year', 'hhidpn'])
    split_idx = int(len(df) * 0.8)
    
    df_train = df.iloc[:split_idx].copy()
    df_test = df.iloc[split_idx:].copy()
    print(f"Time-based split applied: Train (n={len(df_train)}), Test (n={len(df_test)})")
    
    # Separate features from metadata/labels
    exclude_for_training = ['hhidpn', 'entry_wave', 'entry_year', 'cohort_ahead_1995', 'race'] + list(df_labels.columns)
    feature_cols = [c for c in df_features.columns if c not in exclude_for_training]
    
    X_train = df_train[feature_cols]
    y_train = df_train[target_col]
    
    report_content = [
        "# Phase 5: Feature Selection Rationale",
        f"**Target used for ranking:** `{target_col}`\n",
        "## 1. Variance and Multicollinearity Checks"
    ]
    
    # 3. Near-Zero Variance Check (FIT ON TRAIN ONLY)
    vt = VarianceThreshold(threshold=0.01)
    vt.fit(X_train)
    low_var_cols = [c for c, keep in zip(feature_cols, vt.get_support()) if not keep]
    print(f"Low variance features detected: {low_var_cols}")
    report_content.append(f"- **Low Variance Features:** {low_var_cols if low_var_cols else 'None detected.'}")
    
    # 4. Multicollinearity (VIF) on Financials
    fin_cols = [c for c in feature_cols if any(word in c.lower() for word in ['wealth', 'inc', 'asset', 'home', 'equity'])]
    print(f"\nChecking VIF for financial columns: {fin_cols}")
    
    if len(fin_cols) > 1:
        X_fin = add_constant(X_train[fin_cols])
        vif_data = pd.DataFrame()
        vif_data["feature"] = X_fin.columns
        vif_data["VIF"] = [variance_inflation_factor(X_fin.values, i) for i in range(X_fin.shape[1])]
        
        report_content.append("- **Financial VIF Scores:**")
        for _, row in vif_data[vif_data['feature'] != 'const'].iterrows():
            report_content.append(f"  - `{row['feature']}`: {row['VIF']:.2f}")
            print(f"VIF {row['feature']}: {row['VIF']:.2f}")
            
        high_vif = vif_data[(vif_data['VIF'] > 10) & (vif_data['feature'] != 'const')]['feature'].tolist()
        if high_vif:
            report_content.append(f"  - *Action:* High VIF detected in {high_vif}. Typically `total_wealth` is a perfect linear combination of housing + non-housing wealth. We will rely on the preservation mandate to keep `total_wealth` and `income`.")

    # 5. Univariate Association (Mutual Information) - TRAIN ONLY
    print("\nCalculating Mutual Information on training set...")
    mi_scores = mutual_info_classif(X_train.fillna(X_train.median()), y_train, random_state=42)
    mi_series = pd.Series(mi_scores, index=feature_cols).sort_values(ascending=False)
    
    # 6. XGBoost + SHAP Ranking - TRAIN ONLY
    print("Training baseline XGBoost for SHAP ranking on training set...")
    xgb_model = xgb.XGBClassifier(n_estimators=100, max_depth=4, random_state=42, eval_metric='logloss')
    xgb_model.fit(X_train, y_train)
    
    explainer = shap.TreeExplainer(xgb_model)
    shap_values = explainer.shap_values(X_train)
    shap_importance = np.abs(shap_values).mean(axis=0)
    shap_series = pd.Series(shap_importance, index=feature_cols).sort_values(ascending=False)
    
    # 7. Consensus & The Preservation Mandate
    print("\nApplying Preservation Mandate & Generating Final List...")
    
    # The strictly mandated features that CANNOT be dropped
    mandate_keywords = ['inc', 'wealth', 'health', 'age', 'sex', 'gender', 'diab', 'heart', 'canc', 'strok', 'hyper', 'lung']
    whitelisted_cols = [c for c in feature_cols if any(k in c.lower() for k in mandate_keywords)]
    
    # Identify bottom 20% in both MI and SHAP
    bottom_20_percent_idx = int(len(feature_cols) * 0.8)
    mi_bottom = mi_series.iloc[bottom_20_percent_idx:].index.tolist()
    shap_bottom = shap_series.iloc[bottom_20_percent_idx:].index.tolist()
    
    consensus_drop_candidates = set(mi_bottom).intersection(set(shap_bottom)).union(set(low_var_cols))
    
    # Apply VIF drops manually: if we have total_wealth, we drop the sub-components to prevent blowing up the model
    vif_drops = [c for c in high_vif if 'total' not in c.lower() and 'inc' not in c.lower()]
    consensus_drop_candidates.update(vif_drops)
    
    final_drops = []
    final_keeps = []
    
    report_content.extend([
        "\n## 2. Feature Ranking & Preservation Status",
        "| Feature | SHAP Rank | MI Rank | Mandate Protected | Action | Reason |",
        "|---------|-----------|---------|-------------------|--------|--------|"
    ])
    
    for col in feature_cols:
        mi_rank = mi_series.index.get_loc(col) + 1
        shap_rank = shap_series.index.get_loc(col) + 1
        is_protected = col in whitelisted_cols
        
        if col in consensus_drop_candidates and not is_protected:
            action = "Drop"
            reason = "Bottom tier in both MI/SHAP or High VIF"
            final_drops.append(col)
        elif is_protected and col in consensus_drop_candidates:
            action = "Keep"
            reason = "Mandate Protected (Despite low stats/High VIF)"
            final_keeps.append(col)
        else:
            action = "Keep"
            reason = "Strong Predictive Signal"
            final_keeps.append(col)
            
        report_content.append(f"| `{col}` | {shap_rank} | {mi_rank} | {'Yes' if is_protected else 'No'} | {action} | {reason} |")

    print(f"\nFinal Feature Set: {len(final_keeps)} features.")
    print(f"Dropped {len(final_drops)} features: {final_drops}")
    
    # 8. Save Artifacts
    cols_to_save = ['hhidpn', 'entry_wave', 'entry_year', 'cohort_ahead_1995'] + final_keeps
    
    # Save the splits containing the FINAL features
    df_train_final = df_train[cols_to_save]
    df_test_final = df_test[cols_to_save]
    
    train_path = output_features_path.replace(".parquet", "_train.parquet")
    test_path = output_features_path.replace(".parquet", "_test.parquet")
    
    print(f"Saving selected train features to: {train_path}")
    df_train_final.to_parquet(train_path, index=False)
    print(f"Saving selected test features to: {test_path}")
    df_test_final.to_parquet(test_path, index=False)
    
    with open(report_path, "w") as f:
        f.write("\n".join(report_content))
    print(f"Saved feature selection report to: {report_path}")
    
    print("--- Phase 5 Complete ---")

if __name__ == "__main__":
    main()
