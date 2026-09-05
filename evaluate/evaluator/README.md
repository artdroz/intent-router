## Evaluation Plan

The evaluation framework is divided into three distinct stages to validate both the isolated components and the cumulative pipeline. 

### 1. Single Classifiers
**Focus:** Isolated performance, specifically the individual classifier's accuracy and confidence calibration. Each model (Keyword, Semantic, LLM) is evaluated independently.

**Collect:** 
- Ground truth
- Predicted label
- Probability distribution of all classes
- Latency

**Report Metrics - per dataset:**
- **Accuracy:** Measures the overall correctness of the standalone classifier.
- **Expected Calibration Error (ECE):** Measures how well the model's predicted confidence scores align with its actual accuracy. Note: "confidence here refer to the Top-1 Maximum Softmax Probability."

**Report Metrics - overall:**
- **Weighted and Variance of Accuracy**
- **Weighted and Macro ECE**
- **Pooled ECE:** Avoids "Empty Bin" problem but lead to calibration cancalling. Average before applying absolute mix over-confident (-) and under-confident (+).

---

### 2. Router Pre-Cascade
**Focus:** Routing efficiency and decision mechanism logic (Keyword + Semantic). This evaluates the gatekeeper in isolation, assuming the fallback LLM does not exist yet. 

**Collect:** 
- Ground truth
- Pre-cascade predicted label
- Confidence score (margin and entropy)
- Cascade decision

**Report Metrics:**
- **Cascade Rate:** Measures the real-world resource consumption.
- **Silent Error Rate:** Measures the critical system failures.
- **Cascade Precision:** Measures the cascade efficiency.

**Report Metrics - overall:**
- **Weighted and Variance of Cascade Rate**
- **Weighted and Variance of Silent Error Rate**
- **Weighted and Variance of Cascade Precision**

**Threshold Tuning:**
To optimize the margin/entropy thresholds before final testing, we minimize a custom **Routing Regret Function**:
`Regret Cost = (W_Error × Silent_Error_Rate) + (W_Cas × Regret_Cascade_Rate)`
*Note: This cost function is used strictly for parameter tuning on the validation set to balance the Pareto trade-off between confident errors and unnecessary compute waste.*

---

### 3. Final Router
**Focus:** Cumulative system performance. This evaluates the final post-cascade outputs and the real-world viability of the pipeline compared to standard baselines. The final router should ideally achieve near-LLM accuracy at near-Semantic speeds and costs.

**Collect:**
- Ground truth
- Predicted label
- Cascade decision
- Pre-cascade and LLM latency

**Report Metrics:**
- **LLM Conditional Accuracy:** Measures the correctness of the LLM specifically on the complex subset of issues that triggered a cascade.
- **Overall System Accuracy:** Measures the correctness of the entire pipeline.
- **Average Latency:** Measures the operational expense of the pipeline. Evaluated as `(Pre-cascade time × Pre-cascade rate) + (LLM time × Cascade rate)`.

**Report Metrics - overall:**
- **Weighted and Variance of LLM Conditional Accuracy**
- **Weighted and Variance of Overall System Accuracy**
- **Weighted and Variance of Latency**

**Comparison:** Comparative summary tables and bar charts evaluating the Final Router against three strict baselines:
1.  **Baseline 1 (Semantic Only):** Represents the fast, cheap, but lower-accuracy extreme.
2.  **Baseline 2 (LLM Only):** Represents the high-accuracy, but slow and expensive extreme.
3.  **Baseline 3 (lite-llm router):** Represents a real-world, off-the-shelf routing alternative.
