import json
import matplotlib.pyplot as plt
import os

def plot_metric(data, metric_key, metric_name, classifier_name, output_filename):
    """
    Helper function to plot a specific metric against Margin, with lines for each Strength.
    """
    plt.figure(figsize=(10, 6))

    all_strengths = sorted(list(set(row['strengthThr'] for row in data)))
    
    if classifier_name == 'semantic':
        target_strengths = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
        strengths = [s for s in all_strengths if round(s, 1) in target_strengths]
    else:
        strengths = all_strengths
    
    cmap = plt.get_cmap('tab10')
    
    for i, strength in enumerate(strengths):
        strength_data = [row for row in data if row['strengthThr'] == strength]
        strength_data = sorted(strength_data, key=lambda x: x['marginThr'])
        
        margins = [row['marginThr'] for row in strength_data]
        metric_values = [row[metric_key] for row in strength_data]
        
        color = cmap(i % 10)
        
        plt.plot(margins, metric_values, marker='o', linestyle='-', label=f'Strength: {strength}', color=color, markersize=5)

    plt.title(f'{classifier_name.capitalize()} Classifier: {metric_name} vs. Margin')
    plt.xlabel('Margin (marginThr)')
    plt.ylabel(f'{metric_name} (%)')
    
    plt.legend(bbox_to_anchor=(1.05, 1), loc='upper left', fontsize='small')
        
    plt.grid(True, linestyle='--', alpha=0.7)
    plt.tight_layout()
    plt.savefig(output_filename, dpi=300)
    plt.close()
    print(f"✅ Generated plot: {output_filename}")

def process_file(filename, classifier_name):
    if not os.path.exists(filename):
         print(f"⚠️ Warning: Input file '{filename}' not found. Please ensure the typescript script was run and generated this file.")
         return

    data = []
    with open(filename, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                data.append(json.loads(line))

    # 1. Plot SilentErr%
    plot_metric(data, 'silentErrPercent', 'SilentErr%', classifier_name, f'{classifier_name}_silent_err.png')
    
    # 2. Plot RegretCas%
    plot_metric(data, 'regretCasPercent', 'RegretCas%', classifier_name, f'{classifier_name}_regret_cas.png')
    
    # 3. Plot Cascade%
    plot_metric(data, 'cascadePercent', 'Cascade%', classifier_name, f'{classifier_name}_cascade.png')

if __name__ == '__main__':
    # Define input filenames based on what the typescript script generates
    keyword_file = 'keyword-sweep-results.jsonl'
    semantic_file = 'semantic-sweep-results.jsonl'

    print("Starting plotting process...")
    
    # Create dummy files for demonstration purposes if they don't exist
    if not os.path.exists(keyword_file) or not os.path.exists(semantic_file):
        print("Generating dummy data for demonstration since JSONL files aren't present...")
        # Dummy data for Keyword
        with open(keyword_file, 'w') as f:
            for s in range(0, 6):
                for m in [0.0, 0.1, 0.2]:
                     f.write(json.dumps({"strengthThr": s, "marginThr": m, "cascadePercent": 80 + s*2, "regretCasPercent": 30 + s, "silentErrPercent": max(0, 10 - s*2), "cost": 0.4}) + "\n")
        # Dummy data for Semantic
        with open(semantic_file, 'w') as f:
            for s in [0.0, 0.5, 1.0, 1.5, 2.0]:
                for m in [0.0, 0.1, 0.2]:
                     f.write(json.dumps({"strengthThr": s, "marginThr": m, "cascadePercent": 60 + s*10, "regretCasPercent": 20 + s*5, "silentErrPercent": max(0, 5 - s), "cost": 0.3}) + "\n")
    
    process_file(keyword_file, 'keyword')
    process_file(semantic_file, 'semantic')
    print("Plotting complete.")
