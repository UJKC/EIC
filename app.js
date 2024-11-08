const express = require('express');
const { Client } = require('pg');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const excelToJson = require('convert-excel-to-json');

const app = express();
const PORT = process.env.PORT || 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage, dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 }, });

// Middleware
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static('public'));


// PostgreSQL client setup
const client = new Client({
    user: 'postgres',     // Replace with your DB username
    host: 'localhost',          // Replace with your DB host
    database: 'postgres',  // Replace with your DB name
    password: '123456',   // Replace with your DB password
    port: 5432,                 // Default PostgreSQL port
});

// Serve the index.html file at the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index1.html'));
});

// Route to check connectivity
app.get('/check-db', async (req, res) => {
    try {
        await client.connect();
        await client.query('SELECT NOW()'); // Check connection
        res.json({ status: 'success', message: 'Database connected successfully!' });
    } catch (error) {
        res.json({ status: 'error', message: 'Database connection failed!', error: error.message });
    }
});

app.get('/all-tables', async (req, res) => {
    try {
        const result = await client.query('SELECT DISTINCT "PrimaryTable" FROM public.configgroup');
        res.json(result.rows); // Send the rows as JSON
    } catch (error) {
        res.status(500).send('Error fetching data: ' + error.message);
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    // Read the uploaded Excel file
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0]; // Get the first sheet
    const worksheet = workbook.Sheets[sheetName];

    // Get the column headers
    const headers = [];
    const range = xlsx.utils.decode_range(worksheet['!ref']); // Get the range of the worksheet
    for (let col = range.s.c; col <= range.e.c; col++) {
        const cellAddress = { c: col, r: 0 }; // First row (0 index) for headers
        const cellRef = xlsx.utils.encode_cell(cellAddress);
        const cell = worksheet[cellRef];
        if (cell) {
            headers.push(cell.v); // Push the value to the headers array
        }
    }

    // Respond with the headers as JSON
    res.json({ headers });
});

app.post('/upload-excel', upload.single('file'), async (req, res) => {
    const tableName = req.body.tableName; // Get the table name from the request body

    try {
        // Read the uploaded Excel file
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; // Assume we're using the first sheet
        const sheet = workbook.Sheets[sheetName];

        // Convert sheet to JSON format
        const jsonData = XLSX.utils.sheet_to_json(sheet);

        // Prepare the insert statements based on the jsonData
        const insertPromises = jsonData.map(async (row) => {

            const transformedRow = Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key.replace(/ /g, '_'), // Replace spaces with underscores
                    value
                ])
            );

            const columns = Object.keys(transformedRow).map(col => `"${col.replace(/ /g, '_')}"`).join(', ');
            const values = Object.values(row).map((value, index) => `$${index + 1}`).join(', ');

            const insertStatement = `INSERT INTO ${tableName} (${columns}) VALUES (${values});`;
            console.log(insertStatement);
            const insertValues = Object.values(transformedRow);

            // Execute the insert statement
            await client.query(insertStatement, insertValues);
        });

        // Execute all insert statements
        await Promise.all(insertPromises);

        res.status(201).json({ message: 'Data inserted successfully' });
    } catch (error) {
        console.error('Error processing Excel file:', error.message);
        res.status(500).json({ message: 'Error processing Excel file: ' + error.message });
    }
});

app.post('/create-table', async (req, res) => {
    const { tableName, columns } = req.body;

    try {
        // Start building the SQL query to create the new table
        let createTableQuery = `CREATE TABLE public."${tableName}" (`; 

        for (const col of columns) {
            // Replace spaces with underscores in the column name
            const columnName = col.columnName.replace(/ /g, '_');
            const type = col.type === 'character variable' ? 'VARCHAR' : col.type.toUpperCase();
            const keyConstraint = col.key === 'primary key' ? 'PRIMARY KEY' : '';

            // Include SecondaryTable as a foreign key if the key is 'secondary'
            if (col.key === 'secondary' && col.secondaryTable) {
                // Fetch the primary key column of the secondary table from configgroup
                const primaryKeyResult = await client.query(`
                    SELECT "ColumnName"
                    FROM public.configgroup
                    WHERE "PrimaryTable" = $1 AND "Key" = 'primary key';`, [col.secondaryTable]);

                const primaryKeys = primaryKeyResult.rows.map(row => row.ColumnName);
                if (primaryKeys.length > 0) {
                    // Assuming only one primary key for simplicity
                    createTableQuery += `"${columnName}" ${type}, FOREIGN KEY ("${columnName}") REFERENCES "${col.secondaryTable}"("${primaryKeys[0]}"), `;
                }
            } else {
                createTableQuery += `"${columnName}" ${type} ${keyConstraint}, `;
            }
        }

        // Remove the trailing comma and close the parentheses
        createTableQuery = createTableQuery.slice(0, -2) + ');';

        console.log(createTableQuery);

        // Execute the query
        await client.query(createTableQuery);

        for (const col of columns) {
            try {
                const columnName = col.columnName.replace(/ /g, '_'); // Replace spaces with underscores
                await client.query(
                    `INSERT INTO public.configgroup ("ColumnName", "Type", "Key", "PrimaryTable", "SecondaryTable") VALUES ($1, $2, $3, $4, $5)`,
                    [columnName, col.type, col.key, tableName, col.secondaryTable]
                );
            } catch (insertError) {
                console.error('Error inserting into configgroup:', insertError.message);
                return res.status(500).json({ message: 'Error inserting data into configgroup: ' + insertError.message });
            }
        }

        res.status(201).json({ message: 'Table created and column details added successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error creating table: ' + error.message });
    }
});


app.delete('/delete/table', async (req, res) => {
    const { tableName } = req.body;

    if (!tableName) {
        return res.status(400).json({ message: 'Table name is required.' });
    }

    try {
        // Delete the table
        await client.query(`DROP TABLE IF EXISTS "${tableName}";`);

        // Optionally, you might want to remove entries related to this table from configgroup
        await client.query(`DELETE FROM public.configgroup WHERE "PrimaryTable" = $1`, [tableName]);

        res.status(200).json({ message: `Table ${tableName} deleted successfully.` });
    } catch (error) {
        console.error('Error deleting table:', error.message);
        res.status(500).json({ message: 'Error deleting table: ' + error.message });
    }
});

app.get('/tables/:tableName', (req, res) => {
    const tableName = req.params.tableName;
    res.sendFile(path.join(__dirname, '/public/tableDetails1.html'));
});

app.get('/tables/details/:tableName', async (req, res) => {
    const tableName = req.params.tableName;

    try {
        const result = await client.query(`
            SELECT * FROM public.configgroup 
            WHERE "PrimaryTable" = $1 OR "SecondaryTable" = $1
        `, [tableName]);

        res.json(result.rows); // Send the rows as JSON
    } catch (error) {
        console.error('Error fetching table details:', error);
        res.status(500).json({ message: 'Error fetching table details' });
    }
});

app.post('/fetch-joined-data', async (req, res) => {
    const { primaryTable } = req.body;

    try {
        const configResult = await client.query(
            'SELECT "ColumnName", "Key", "SecondaryTable" FROM public.configgroup WHERE "PrimaryTable" = $1',
            [primaryTable]
        );

        console.log("Here")

        let selectColumns = [];
        let secondaryColumns = [];
        let fromClause = `${primaryTable}`;
        let joinClauses = [];
        let whereConditions = [];

        for (const row of configResult.rows) {
            const { ColumnName, Key, SecondaryTable } = row;

            console.log(`Processing column: ${ColumnName}, Key: ${Key}, SecondaryTable: ${SecondaryTable}`); // Logging
            
            // Add primary and normal columns to select
            if (Key === 'primary key' || Key === 'normal') {
                selectColumns.push(`${primaryTable}."${ColumnName}"`);
            }

            // Handle secondary columns
            if (Key === 'secondary' && SecondaryTable) {
                selectColumns.push(`${primaryTable}."${ColumnName}"`);
                const secondaryKeyResult = await client.query(
                    'SELECT "ColumnName" FROM public.configgroup WHERE "PrimaryTable" = $1 AND "Key" = $2',
                    [SecondaryTable, 'primary key']
                );

                const secondaryKey = secondaryKeyResult.rows[0]?.ColumnName;
                console.log(`Secondary Key for ${SecondaryTable}: ${secondaryKey}`); // Logging
                
                if (secondaryKey) {
                    // Construct the join clause
                    if (ColumnName === secondaryKey) {
                        joinClauses.push(`LEFT JOIN ${SecondaryTable} ON ${primaryTable}.${ColumnName} = ${SecondaryTable}.${secondaryKey}`);
                    } else {
                        joinClauses.push(`LEFT JOIN ${SecondaryTable} ON ${primaryTable}.${ColumnName} = ${SecondaryTable}.${secondaryKey}`);
                    }
                    
                    // Add all columns from the SecondaryTable to select
                    const secondaryColumnsResult = await client.query(
                        'SELECT "ColumnName" FROM public.configgroup WHERE "PrimaryTable" = $1',
                        [SecondaryTable]
                    );

                    // Add each column from the secondary table to select, without performing operations on them
                    secondaryColumnsResult.rows.forEach(secRow => {
                        secondaryColumns.push(`${SecondaryTable}."${secRow.ColumnName}" AS ${SecondaryTable}_${secRow.ColumnName}`);
                    });
                }
            }
        }

        console.log("Here1")

        selectColumns = selectColumns.concat(secondaryColumns);

        console.log(`Select Columns: ${selectColumns.join(', ')}`); // Logging
        console.log(`Join Clauses: ${joinClauses.join(' ')}`); // Logging
        
        const sqlQuery = `
            SELECT ${selectColumns.join(', ')} 
            FROM ${fromClause} 
            ${joinClauses.join(' ')} 
            ${whereConditions.length ? 'WHERE ' + whereConditions.join(' AND ') : ''}
        `;

        console.log(sqlQuery)

        console.log("Here2")

        const result = await client.query(sqlQuery);
        console.log(result)

        console.log("Here3")
        res.json(result.rows); 
    } catch (error) {
        console.log(error)
        console.error(error.message);
        res.status(500).json({ message: 'Error fetching data: ' + error.message });
    }
});

app.get('/table/details/:tableName/length', async (req, res) => {
    const tableName = req.params.tableName;

    try {
        const result = await client.query(`
            SELECT * FROM public.configgroup 
            WHERE "PrimaryTable" = $1
        `, [tableName]);

        var columnCount = result.rows.length

        res.json({ length: columnCount }); // Send the rows as JSON
    } catch (error) {
        console.error('Error fetching table details:', error);
        res.status(500).json({ message: 'Error fetching table details' });
    }
});

app.get('/table/details/:tableName/primary', async (req, res) => {
    const tableName = req.params.tableName;
    try {
        const result = await client.query(
            'SELECT "ColumnName" FROM public.configgroup WHERE "PrimaryTable" = $1 AND "Key" = $2',
            [tableName, 'primary key']
        );
        const secondaryKey = result.rows[0]?.ColumnName;
        console.log(secondaryKey) // Adjust if necessary based on your DB setup
        res.json({ secondaryKey });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching primary keys.' });
    }
});

app.get('/table/details/:tableName/secondary', async (req, res) => {
    const tableName = req.params.tableName;
    try {
        const result = await client.query(
            'SELECT "ColumnName" FROM public.configgroup WHERE "PrimaryTable" = $1 AND "Key" = $2',
            [tableName, 'secondary']
        );

        // Extract secondary keys into an array
        const secondaryKeys = result.rows.map(row => row.ColumnName);
        console.log(secondaryKeys); // For debugging

        res.json({ secondaryKeys }); // Return the array of secondary keys
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching secondary keys.' });
    }
});

app.get('/form/:tableName/:id', async (req, res) => {
    const tableName = req.params.tableName;
    const primaryKeyValue = req.params.id;

    // Fetch the row based on the primary key
    const result = await client.query(`SELECT * FROM public.${tableName} WHERE ${primaryKeyColumn} = $1`, [primaryKeyValue]);
    res.json(result.rows[0]); // Return the fetched row
});

app.post('/table/:tableName/update/row/', async (req, res) => {
    // Access the form data
    const formData = req.body;

    // Log the form data to the console
    console.log('Received form data:', formData);
    try {

        var primaryKeyColumnName = formData["primaryKeyColumn"]
        console.log("primaryKeyColumnName" + primaryKeyColumnName)
        var tableNamefromData = formData['tableName']
        console.log("tableName" + tableNamefromData)
        var primaryKeyValue = formData[primaryKeyColumnName]
        console.log("primaryKeyValue" + primaryKeyValue)

        const existingRowResponse = await client.query(`SELECT * FROM public.${tableNamefromData} WHERE ${primaryKeyColumnName} = $1`, [primaryKeyValue]);
        const existingRow = existingRowResponse.rows[0];
        console.log("Existing Row:", existingRow);

        const { primaryKeyColumn, tableName, ...remainingData } = formData;
        console.log("remainingData" + JSON.stringify(remainingData))
        let remainingDataFuture = remainingData

        const updates = [];
        const values = [];

        for (const key in remainingDataFuture) {
            if (key !== primaryKeyColumn && remainingDataFuture[key] !== existingRow[key]) {
                updates.push(`${key} = $${values.length + 1}`);
                values.push(req.body[key]);
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'No changes detected' });
        }

        const updateStatement = `UPDATE ${tableNamefromData} SET ${updates.join(', ')} WHERE ${primaryKeyColumnName} = $${values.length + 1}`;
        console.log(updateStatement);
        values.push(primaryKeyValue);

        await client.query(updateStatement, values);
        res.redirect(`/tables/${tableNamefromData}`);
    } catch (error) {
        console.error('Error updating row:', error.message);
        res.status(500).json({ message: 'Error updating row: ' + error.message });
    }
});

app.get('/tables/details/:tableName/columns', async (req, res) => {
    const tableName = req.params.tableName;

    try {
        const result = await client.query(`
            SELECT * FROM public.configgroup 
            WHERE "PrimaryTable" = $1
        `, [tableName]);

        const columnNames = result.rows.map(row => row.ColumnName);
        console.log("columnNames" + columnNames)
        res.json(columnNames); // Send the rows as JSON
    } catch (error) {
        console.error('Error fetching table details:', error);
        res.status(500).json({ message: 'Error fetching table details' });
    }
});

app.post('/tables/:tableName/insert', async (req, res) => {
    const tableName = req.params.tableName;
    
    const formData = req.body;
    console.log(formData)
    try {
        // Extract column names and values
        const columns = Object.keys(formData);
        const values = Object.values(formData);

        // Prepare the column names and placeholders for the values
        const columnNames = columns.map(col => `"${col}"`).join(', ');
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');

        // Construct the SQL insert statement
        const insertStatement = `INSERT INTO public.${tableName} (${columnNames}) VALUES (${placeholders})`;

        // Execute the insert statement
        await client.query(insertStatement, values);

        res.redirect(`/tables/${tableName}`);
    } catch (error) {
        console.error('Error inserting data:', error.message);
        res.status(500).json({ message: 'Error inserting data: ' + error.message });
    }
});

app.delete('/table/:tableName/delete/:primaryColumnName/:id', async (req, res) => {
    const { tableName, primaryColumnName, id } = req.params;

    try {
        // Generate the SQL statement
        const sql = `DELETE FROM public.${tableName} WHERE ${primaryColumnName} = $1;`;

        // Execute the SQL statement
        const result = await client.query(sql, [id]);

        // Check if any row was deleted
        if (result.rowCount > 0) {
            res.redirect(`/tables/${tableName}`);
        } else {
            res.status(404).send({
                message: 'No row found to delete',
                sql: sql
            });
        }
    } catch (error) {
        console.error('Error deleting row:', error);
        res.status(500).send({
            message: 'Error deleting row',
            error: error.message
        });
    }
});

app.post('/add-column', async (req, res) => {
    console.log(req.body)
    const { primaryTable } = req.body;
    const columnNames = req.body.columnName;
    const keyTypes = req.body.keyType;
    const secondaryTables = req.body.secondaryTable;
    const defaults = req.body.default;
    const types = req.body.type;

    try {
        for (let i = 0; i < columnNames.length; i++) {
            const columnName = columnNames[i];
            const keyType = keyTypes[i];
            const secondaryTable = keyType === 'secondary' ? secondaryTables[i] : null;
            const type = types[i];

            // Construct the SQL statement
            const alterTableQuery = `ALTER TABLE public.${primaryTable} ADD COLUMN ${columnName} ${type};`;
            await client.query(alterTableQuery);

            if (secondaryTable) {
                // Fetch the primary key column name from the secondary table
                const secondaryKeyResult = await client.query(
                    'SELECT "ColumnName" FROM public.configgroup WHERE "PrimaryTable" = $1 AND "Key" = $2',
                    [secondaryTable, 'primary key']
                );

                const secondaryKey = secondaryKeyResult.rows[0]?.ColumnName;

                if (secondaryKey) {
                    const addForeignKeyQuery = `ALTER TABLE public.${primaryTable} ADD CONSTRAINT fk_${columnName} FOREIGN KEY (${columnName}) REFERENCES public.${secondaryTable} (${secondaryKey});`;
                    await client.query(addForeignKeyQuery);
                } else {
                    console.error(`No primary key found for secondary table: ${secondaryTable}`);
                }
            }

            // Insert into public.config group
            const insertConfigQuery = `INSERT INTO public.configgroup ("ColumnName", "Type", "Key", "PrimaryTable", "SecondaryTable") VALUES ($1, $2, $3, $4, $5);`;
            console.log(insertConfigQuery)
            await client.query(insertConfigQuery, [columnName, type, keyType, primaryTable, secondaryTable]);
        }

        res.status(200).send('Columns added successfully');
    } catch (error) {
        console.error('Error adding columns:', error);
        res.status(500).send('Failed to add columns');
    }
});

app.get('/tables/:tableName/get', async (req, res) => {
    const { tableName } = req.params;

    try {
        // Get columns for the specified table
        const columnsResult = await client.query(`SELECT * FROM information_schema.columns WHERE table_name = $1`, [tableName]);
        const columns = columnsResult.rows;

        // Render a simple HTML form with checkboxes for each column
        let html = `
            <h1>Delete Columns from ${tableName}</h1>
            <form action="/tables/${tableName}/deleteColumn" method="POST">
                <ul>
        `;
        
        columns.forEach(column => {
            html += `<li>
                <input type="checkbox" name="columnsToDelete" value="${column.column_name}"> ${column.column_name}
            </li>`;
        });

        html += `
                </ul>
                <button type="submit">Delete Selected Columns</button>
            </form>
        `;

        res.send(html);
    } catch (error) {
        console.error('Error fetching columns:', error);
        res.status(500).send('Failed to retrieve columns');
    }
});

app.post('/tables/:tableName/deleteColumn', async (req, res) => {
    const { tableName } = req.params;
    let columnsToDelete = req.body.columnsToDelete; // This can be a string or an array

    try {
        // Normalize columnsToDelete into an array
        if (!Array.isArray(columnsToDelete)) {
            columnsToDelete = [columnsToDelete]; // Convert string to array
        }

        if (columnsToDelete.length === 0) {
            return res.status(400).send('No columns selected for deletion.');
        }

        for (const columnName of columnsToDelete) {
            // Drop the column from the table
            const dropColumnQuery = `ALTER TABLE public.${tableName} DROP COLUMN IF EXISTS ${columnName};`;
            await client.query(dropColumnQuery);

            // Delete the corresponding row in public.config
            const deleteConfigQuery = `DELETE FROM public.configgroup WHERE "PrimaryTable" = $1 AND "ColumnName" = $2;`;
            await client.query(deleteConfigQuery, [tableName, columnName]);
        }

        res.status(200).send('Columns deleted successfully.');
    } catch (error) {
        console.error('Error deleting columns:', error);
        res.status(500).send('Failed to delete columns');
    }
});

app.get('/tables/:tableName/alter', async (req, res) => {
    const { tableName } = req.params;
    console.log(tableName)

    try {
        // Get columns for the specified table
        const columnsResult = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tableName]);
        const columns = columnsResult.rows;

        // Build the form HTML
        let formHtml = `
            <h2>Rename Column in ${tableName}</h2>
            <form action="/tables/${tableName}/renameColumn" method="POST">
                <label for="columnToRename">Select Column:</label>
                <select name="columnToRename" required>
        `;
        
        columns.forEach(column => {
            formHtml += `<option value="${column.column_name}">${column.column_name}</option>`;
        });

        formHtml += `
                </select>
                <br>
                <label for="newColumnName">New Column Name:</label>
                <input type="text" name="newColumnName" required>
                <br>
                <button type="submit">Rename Column</button>
            </form>
        `;

        console.log(formHtml)

        // Send the form HTML back to be embedded in an existing webpage
        res.send(formHtml);
    } catch (error) {
        console.error('Error fetching columns:', error);
        res.status(500).send('Failed to retrieve columns');
    }
});

app.post('/tables/:tableName/renameColumn', async (req, res) => {
    const { tableName } = req.params;
    const { columnToRename, newColumnName } = req.body;

    try {
        // Alter the column name in the specified table
        const alterColumnQuery = `ALTER TABLE public.${tableName} RENAME COLUMN ${columnToRename} TO ${newColumnName};`;
        await client.query(alterColumnQuery);

        // Update the corresponding entry in public.config if needed
        const updateConfigQuery = `UPDATE public.configgroup SET "ColumnName" = $1 WHERE "PrimaryTable" = $2 AND "ColumnName" = $3;`;
        await client.query(updateConfigQuery, [newColumnName, tableName, columnToRename]);

        res.status(200).send('Column renamed successfully.');
    } catch (error) {
        console.error('Error renaming column:', error);
        res.status(500).send('Failed to rename column');
    }
});

// Endpoint to get rules
app.get('/rules', async (req, res) => {
    try {
        const result = await client.query("SELECT id, table_name, rule, functioncall, argument FROM public.rules;");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching rules');
    }
});

// Create a new rule
app.post('/rules', async (req, res) => {
    const { table_name, rule, functioncall, argument } = req.body;
    console.log(rule)
    
    try {
        // Execute the rule here
        const executionResult = await client.query(rule); // Adjust this if the rule needs parameters
        
        // If execution is successful, proceed to insert the rule
        if (executionResult) {
            const result = await client.query(
                "INSERT INTO public.rules (table_name, rule, functioncall, argument) VALUES ($1, $2, $3, $4) RETURNING *;",
                [table_name, rule, functioncall, argument]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Error executing rule or creating rule');
    }
});


// Update an existing rule
app.put('/rules/:id', async (req, res) => {
    const { id } = req.params;
    const { table_name, rule, functioncall, argument } = req.body;

    try {
        // Execute the rule before updating
        const executionResult = await client.query(rule); // Adjust if needed

        // If execution is successful, update the rule
        if (executionResult) {
            const result = await client.query(
                "UPDATE public.rules SET table_name = $1, rule = $2, functioncall = $3, argument = $4 WHERE id = $5 RETURNING *;",
                [table_name, rule, functioncall, argument, id]
            );
            res.json(result.rows[0]);
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Error executing rule or updating rule');
    }
});


// Delete a rule
app.delete('/rules/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Retrieve the function name associated with the rule
        const ruleResult = await client.query("SELECT functioncall FROM public.rules WHERE id = $1;", [id]);
        
        if (ruleResult.rows.length === 0) {
            return res.status(404).send('Rule not found');
        }

        const functionName = ruleResult.rows[0].functioncall;

        // Drop the function if it exists
        if (functionName) {
            await client.query(`DROP FUNCTION IF EXISTS ${functionName}();`);
        }

        // Now delete the rule from the rules table
        await client.query("DELETE FROM public.rules WHERE id = $1;", [id]);
        res.status(204).send(); // No Content
    } catch (err) {
        console.error(err);
        res.status(500).send('Error deleting rule');
    }
});

app.post('/reupload', upload.single('file'), async (req, res) => {
    const { tableName, ruleId } = req.body;
    const fileBuffer = req.file.buffer;

    try {
        // Read the Excel file from the buffer
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; // Get the first sheet
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 }); // Convert to JSON

        // The first row is usually the headers
        const headers = data[0];
        const rows = data.slice(1); // Get the data rows

        // Retrieve the primary key column for the specified table
        const primaryKeyResult = await client.query(
            'SELECT "ColumnName" FROM public.configgroup WHERE "PrimaryTable" = $1 AND "Key" = $2',
            [tableName, 'primary key']
        );

        const primaryKey = primaryKeyResult.rows[0]?.ColumnName;

        // Fetch the function call and argument from the rules table
        const ruleResult = await client.query(
            'SELECT functioncall, argument FROM public.rules WHERE id = $1',
            [ruleId]
        );

        if (ruleResult.rows.length === 0) {
            return res.status(404).send('Rule not found');
        }

        const { functioncall, argument } = ruleResult.rows[0];

        // Process each row based on the selected rule
        for (const row of rows) {
            const rowData = headers.reduce((acc, header, index) => {
                acc[header] = row[index];
                return acc;
            }, {});

            // Construct the SQL function call
            const args = [];
            for (let i = 0; i < argument; i++) {
                args.push(rowData[headers[i]]); // Adjust this logic based on how you want to map arguments
            }
            const sqlFunctionCall = `${functioncall}(${args.join(', ')})`;

            // Execute the function call
            try {
                await client.query(sqlFunctionCall);
            } catch (execError) {
                console.error('Error executing function call:', execError);
                return res.status(500).send('Error executing function call');
            }
        }

        res.status(200).send('File processed successfully');
    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).send('Error processing file');
    }
});

app.get('/addrule', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rules.html'));
});

app.post('/execute-rule', async (req, res) => {
    const { ruleId, args } = req.body;
    console.log(args)

    try {
        // Fetch the function call from the rules table
        const ruleResult = await client.query(
            'SELECT functioncall FROM public.rules WHERE id = $1',
            [ruleId]
        );

        if (ruleResult.rows.length === 0) {
            return res.status(404).send('Rule not found');
        }

        const { functioncall } = ruleResult.rows[0];

        // Construct the SQL function call
        const sqlFunctionCall = `${functioncall}(${args.join(', ')})`;

        // Execute the function call
        await client.query(sqlFunctionCall);
        res.status(200).send('Rule executed successfully');
    } catch (error) {
        console.error('Error executing rule:', error);
        res.status(500).send('Error executing rule');
    }
});

app.get('/rules/:id', async (req, res) => {
    const { id } = req.params; // Get the rule ID from the URL parameters

    try {
        const result = await client.query(
            'SELECT * FROM public.rules WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Rule not found' });
        }

        res.json(result.rows[0]); // Return the rule details as JSON
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching rule');
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
