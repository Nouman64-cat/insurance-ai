import numpy as np

def calibrate_mortality_risk(
    raw_pred: float, 
    model_avg_pred: float, 
    pakistan_qx: float, 
    Z: float = 0.85
) -> float:
    """
    Bayesian credibility weighting (Bühlmann-style) for mortality risk.
    
    Parameters
    ----------
    raw_pred : float
        The individual's raw prediction from the HRS-trained model.
    model_avg_pred : float
        The average raw prediction from the HRS model for this individual's age_band x sex bucket.
    pakistan_qx : float
        The population-level mortality rate for this individual's age_band x sex bucket in Pakistan (from PDS).
    Z : float, default=0.85
        Credibility factor. Weight placed on the Pakistani population anchor (0 <= Z <= 1).
        
    Returns
    -------
    float
        The calibrated individual risk, clipped to [0, 0.999].
    """
    if not (0 <= Z <= 1):
        raise ValueError("Z must be between 0 and 1.")
        
    # Edge case: Avoid division by zero
    if model_avg_pred <= 0:
        # If model average prediction is 0, we can't determine relative risk.
        # Fall back completely to the population anchor, or blended baseline.
        # Here we just return the blended baseline since relative risk is 1 by definition.
        model_avg_pred = 1e-9
        
    blended_baseline = Z * pakistan_qx + (1 - Z) * model_avg_pred
    
    # Calculate calibrated risk
    individual_calibrated_risk = blended_baseline * (raw_pred / model_avg_pred)
    
    # Ensure risk doesn't exceed 0.999 or drop below 0
    return float(np.clip(individual_calibrated_risk, 0.0, 0.999))

if __name__ == "__main__":
    # Simple Unit Tests
    def test_calibration():
        print("Running unit tests for calibration.py...")
        
        # Test 1: Normal case
        raw = 0.05
        avg = 0.10
        qx = 0.15
        z = 0.85
        expected_blend = 0.85 * 0.15 + 0.15 * 0.10
        expected = expected_blend * (raw / avg)
        res = calibrate_mortality_risk(raw, avg, qx, z)
        assert np.isclose(res, expected), f"Test 1 Failed: {res} != {expected}"
        
        # Test 2: raw_pred is 0
        res = calibrate_mortality_risk(0.0, 0.10, 0.15, 0.85)
        assert res == 0.0, f"Test 2 Failed: {res} != 0.0"
        
        # Test 3: model_avg_pred is 0 (avoids div by zero)
        res = calibrate_mortality_risk(0.05, 0.0, 0.15, 0.85)
        # avg = 1e-9 -> blend = 0.85 * 0.15 + 0.15 * 1e-9
        # result = blend * (0.05 / 1e-9) -> will clip to 0.999
        assert res == 0.999, f"Test 3 Failed: {res} != 0.999"
        
        # Test 4: clipping above 0.999
        res = calibrate_mortality_risk(0.9, 0.1, 0.5, 0.85)
        assert res == 0.999, f"Test 4 Failed: {res} != 0.999"
        
        print("All tests passed!")

    test_calibration()
