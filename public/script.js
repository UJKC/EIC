async function fetchRules() {
    const response = await fetch('/rules');
    const rules = await response.json();
    return rules; // Return the rules for further processing
}

function displayRules(rules) {
    const container = document.getElementById('rules-container');
    container.innerHTML = ''; // Clear existing content

    rules.forEach(rule => {
        const ruleDiv = document.createElement('div');
        ruleDiv.innerHTML = `
            <h3>Table: ${rule.table_name}</h3>
            <ul>
                <li><strong>Rule:</strong> ${rule.rule}</li>
                <li><strong>Function Call:</strong> ${rule.functioncall || 'N/A'}</li>
                <li><strong>Argument:</strong> ${rule.argument || 'N/A'}</li>
                <li>
                    <button onclick="editRule(${rule.id})">Edit</button>
                    <button onclick="deleteRule(${rule.id})">Delete</button>
                </li>
            </ul>
        `;
        container.appendChild(ruleDiv);
    });
}

async function addRule(event) {
    event.preventDefault();
    const table_name = document.getElementById('table_name').value;
    const rule = document.getElementById('rule').value;
    const functioncall = document.getElementById('functioncall').value;
    const argument = document.getElementById('argument').value;

    const response = await fetch('/rules', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ table_name, rule, functioncall, argument })
    });

    if (response.ok) {
        fetchAndDisplayRules(); // Refresh the list
        document.getElementById('add-rule-form').reset(); // Reset form
    }
}

async function deleteRule(id) {
    const response = await fetch(`/rules/${id}`, { method: 'DELETE' });
    if (response.ok) {
        fetchAndDisplayRules(); // Refresh the list
    }
}

async function editRule(id) {
    const newRule = prompt("Enter new rule details (table_name, rule, functioncall, argument) separated by commas:");
    if (newRule) {
        const [table_name, rule, functioncall, argument] = newRule.split(',');
        const response = await fetch(`/rules/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ table_name, rule, functioncall, argument: parseInt(argument) })
        });
        if (response.ok) {
            fetchAndDisplayRules(); // Refresh the list
        }
    }
}

function filterRules(rules) {
    const searchBar = document.getElementById('search-bar');
    const searchTerm = searchBar.value.toLowerCase();

    return rules.filter(rule => 
        rule.table_name.toLowerCase().includes(searchTerm) ||
        rule.rule.toLowerCase().includes(searchTerm) ||
        (rule.functioncall && rule.functioncall.toLowerCase().includes(searchTerm)) ||
        (rule.argument !== null && rule.argument.toString().includes(searchTerm))
    );
}

// Fetch rules on page load and setup search
async function fetchAndDisplayRules() {
    const rules = await fetchRules();
    displayRules(rules);
}

// Setup event listeners
document.getElementById('add-rule-form').addEventListener('submit', addRule);
document.getElementById('search-bar').addEventListener('input', async () => {
    const rules = await fetchRules();
    const filteredRules = filterRules(rules);
    displayRules(filteredRules);
});

// Initial fetch
fetchAndDisplayRules();
