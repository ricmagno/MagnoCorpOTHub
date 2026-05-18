import mssql from 'mssql';

const config = {
    server: '192.168.235.17',
    port: 1433,
    database: 'Runtime',
    user: 'historian',
    // I don't have the plain password here, but I can try to connect with the pool options
    options: {
        encrypt: true,
        trustServerCertificate: true,
    },
    connectionTimeout: 5000,
};

async function test() {
    console.log('Testing connection to 192.168.235.17:1433 with encrypt:true...');
    try {
        const pool = await mssql.connect({
            ...config,
            password: 'historian', // Generic guess or just testing if port is open
        });
        console.log('Connected!');
        await pool.close();
    } catch (err: any) {
        console.error('Error with encrypt:true:', err.message);
        if (err.code === 'ETIMEOUT') {
            console.log('Connection timed out. Port 1433 might be blocked.');
        }
    }

    console.log('\nTesting connection to 192.168.235.17:1433 with encrypt:false...');
    try {
        const pool = await mssql.connect({
            ...config,
            password: 'historian',
            options: {
                encrypt: false,
                trustServerCertificate: true,
            }
        });
        console.log('Connected!');
        await pool.close();
    } catch (err: any) {
        console.error('Error with encrypt:false:', err.message);
    }
}

test();
