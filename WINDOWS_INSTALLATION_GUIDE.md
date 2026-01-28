# Historian Reports Application - Windows Installation Guide

## System Requirements

### Minimum Requirements
- **OS**: Windows 10 or Windows Server 2016+
- **RAM**: 4 GB (8 GB recommended)
- **Disk Space**: 2 GB for application + database storage
- **Network**: Internet connection for initial setup

### Required Software
- **Node.js**: v16.0.0 or higher (LTS recommended)
- **npm**: v7.0.0 or higher (comes with Node.js)
- **SQL Server**: 2016 or higher (for AVEVA Historian database)
- **Git**: Optional (for cloning repository)

## Pre-Installation Steps

### 1. Install Node.js

1. Download Node.js LTS from https://nodejs.org/
2. Run the installer (.msi file)
3. Follow the installation wizard:
   - Accept the license agreement
   - Choose installation directory (default: `C:\Program Files\nodejs`)
   - Select "npm package manager" (should be checked by default)
   - Click "Install"
4. Verify installation by opening Command Prompt and running:
   ```cmd
   node --version
   npm --version
   ```

### 2. Install Git (Optional but Recommended)

1. Download Git from https://git-scm.com/download/win
2. Run the installer
3. Follow the installation wizard with default settings
4. Verify installation:
   ```cmd
   git --version
   ```

### 3. Prepare Database Connection

Ensure you have:
- SQL Server instance running and accessible
- Database credentials (username/password)
- Database name for Historian data
- Server hostname or IP address
- Port number (default: 1433)

## Installation Steps

### Option A: Using Git (Recommended)

1. Open Command Prompt or PowerShell
2. Navigate to desired installation directory:
   ```cmd
   cd C:\Users\YourUsername\Documents
   ```
3. Clone the repository:
   ```cmd
   git clone https://github.com/your-org/historian-reports.git
   cd historian-reports
   ```
4. Continue with "Common Installation Steps" below

### Option B: Using ZIP File

1. Download the application ZIP file
2. Extract to desired location (e.g., `C:\Applications\historian-reports`)
3. Open Command Prompt and navigate to the extracted folder:
   ```cmd
   cd C:\Applications\historian-reports
   ```
4. Continue with "Common Installation Steps" below

### Common Installation Steps

1. **Install Dependencies**
   ```cmd
   npm install
   ```
   This installs all required Node.js packages (may take 5-10 minutes)

2. **Install Client Dependencies**
   ```cmd
   cd client
   npm install
   cd ..
   ```

3. **Create Environment Configuration**
   
   Copy the example environment file:
   ```cmd
   copy .env.example .env
   ```
   
   Edit `.env` file with your configuration:
   ```
   # Database Configuration
   DB_HOST=your-sql-server-hostname
   DB_PORT=1433
   DB_NAME=HistorianDatabase
   DB_USER=your-username
   DB_PASSWORD=your-password
   DB_ENCRYPT=true
   DB_TRUST_SERVER_CERTIFICATE=false

   # Application Configuration
   NODE_ENV=production
   PORT=3000
   JWT_SECRET=your-secure-random-string-min-32-characters
   BCRYPT_ROUNDS=12

   # Email Configuration (for report delivery)
   SMTP_HOST=your-smtp-server
   SMTP_PORT=587
   SMTP_SECURE=true
   SMTP_USER=your-email@company.com
   SMTP_PASSWORD=your-email-password

   # Report Configuration
   REPORTS_DIR=./reports
   TEMP_DIR=./temp
   MAX_REPORT_SIZE_MB=50

   # Logging
   LOG_LEVEL=info
   LOG_FILE=./logs/app.log
   LOG_MAX_SIZE=10m
   LOG_MAX_FILES=5
   ```

4. **Create Required Directories**
   ```cmd
   mkdir reports
   mkdir logs
   mkdir temp
   mkdir data
   ```

5. **Initialize Database**
   ```cmd
   npm run setup:db
   ```

6. **Build the Application**
   ```cmd
   npm run build
   npm run build:client
   ```

## Running the Application

### Development Mode

1. Open Command Prompt in the application directory
2. Start the development server:
   ```cmd
   npm run dev
   ```
3. In another Command Prompt window, start the frontend:
   ```cmd
   cd client
   npm start
   ```
4. Access the application at `http://localhost:3000`

### Production Mode

1. Build the application (if not already done):
   ```cmd
   npm run build:all
   ```

2. Start the production server:
   ```cmd
   npm start
   ```

3. Access the application at `http://localhost:3000` (or configured port)

## Windows Service Installation (Optional)

To run the application as a Windows Service:

### Using NSSM (Node Simple Service Manager)

1. Download NSSM from https://nssm.cc/download
2. Extract to a folder (e.g., `C:\nssm`)
3. Open Command Prompt as Administrator
4. Navigate to NSSM folder:
   ```cmd
   cd C:\nssm\win64
   ```
5. Install the service:
   ```cmd
   nssm install HistorianReports "C:\Program Files\nodejs\node.exe" "C:\path\to\app\server.js"
   ```
6. Configure service startup:
   ```cmd
   nssm set HistorianReports AppDirectory C:\path\to\app
   nssm set HistorianReports AppEnvironmentExtra NODE_ENV=production
   nssm set HistorianReports Start SERVICE_AUTO_START
   ```
7. Start the service:
   ```cmd
   nssm start HistorianReports
   ```

### Verify Service Installation

1. Open Services (services.msc)
2. Look for "HistorianReports" in the list
3. Verify status is "Running"

## Docker Installation (Alternative)

If you prefer containerized deployment:

1. Install Docker Desktop from https://www.docker.com/products/docker-desktop
2. Build the Docker image:
   ```cmd
   docker build -t historian-reports .
   ```
3. Run the container:
   ```cmd
   docker run -p 3000:3000 --env-file .env historian-reports
   ```

## Post-Installation Configuration

### 1. Create Initial User

```cmd
npm run seed:users
```

This creates a default admin user:
- Username: `admin`
- Password: `admin123` (change immediately)

### 2. Configure Database Connection

1. Access the application at `http://localhost:3000`
2. Log in with admin credentials
3. Navigate to Settings → Database Configuration
4. Test the connection
5. Save configuration

### 3. Set Up Email (Optional)

1. Go to Settings → Email Configuration
2. Enter SMTP server details
3. Test email delivery
4. Save configuration

### 4. Configure Report Settings

1. Go to Settings → Report Configuration
2. Set report directory path
3. Configure chart dimensions
4. Set maximum report size
5. Save configuration

## Troubleshooting

### Port Already in Use

If port 3000 is already in use:

1. Find the process using the port:
   ```cmd
   netstat -ano | findstr :3000
   ```
2. Kill the process:
   ```cmd
   taskkill /PID <PID> /F
   ```
3. Or change the port in `.env`:
   ```
   PORT=3001
   ```

### Database Connection Failed

1. Verify SQL Server is running:
   ```cmd
   sqlcmd -S your-server-name -U your-username -P your-password
   ```
2. Check firewall settings allow port 1433
3. Verify credentials in `.env` file
4. Check SQL Server is configured for TCP/IP connections

### npm install Fails

1. Clear npm cache:
   ```cmd
   npm cache clean --force
   ```
2. Delete node_modules folder:
   ```cmd
   rmdir /s /q node_modules
   ```
3. Reinstall:
   ```cmd
   npm install
   ```

### Application Won't Start

1. Check logs:
   ```cmd
   type logs\app.log
   ```
2. Verify all environment variables are set correctly
3. Check Node.js version compatibility:
   ```cmd
   node --version
   ```
4. Try running in development mode for more detailed errors:
   ```cmd
   npm run dev
   ```

## Firewall Configuration

### Allow Application Through Firewall

1. Open Windows Defender Firewall
2. Click "Allow an app through firewall"
3. Click "Change settings"
4. Click "Allow another app"
5. Browse to Node.js executable: `C:\Program Files\nodejs\node.exe`
6. Click "Add"
7. Ensure both "Private" and "Public" are checked

## Security Recommendations

1. **Change Default Credentials**
   - Change admin password immediately after first login
   - Create individual user accounts

2. **Enable HTTPS**
   - Generate SSL certificate
   - Configure in `.env`:
     ```
     HTTPS_CERT_PATH=./certs/cert.pem
     HTTPS_KEY_PATH=./certs/key.pem
     ```

3. **Secure Environment Variables**
   - Never commit `.env` to version control
   - Use strong passwords (min 32 characters for JWT_SECRET)
   - Restrict file permissions on `.env`

4. **Database Security**
   - Use strong database passwords
   - Enable SQL Server encryption
   - Restrict database user permissions

5. **Regular Backups**
   - Backup database regularly
   - Backup reports directory
   - Backup configuration files

## Updating the Application

### From Git Repository

1. Navigate to application directory
2. Pull latest changes:
   ```cmd
   git pull origin main
   ```
3. Install any new dependencies:
   ```cmd
   npm install
   ```
4. Rebuild:
   ```cmd
   npm run build:all
   ```
5. Restart the application

### Manual Update

1. Download latest version
2. Extract to temporary location
3. Copy new files over existing installation
4. Run `npm install` to update dependencies
5. Restart the application

## Performance Tuning

### Increase Node.js Memory

Edit the startup command to allocate more memory:

```cmd
node --max-old-space-size=4096 server.js
```

### Database Connection Pooling

Configure in `.env`:

```
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_TIMEOUT_MS=30000
```

### Enable Caching

```
CACHE_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
CACHE_TTL_SECONDS=300
```

## Monitoring and Maintenance

### Check Application Status

```cmd
netstat -ano | findstr :3000
```

### View Logs

```cmd
type logs\app.log
```

### Monitor Performance

1. Open Task Manager
2. Look for Node.js process
3. Monitor CPU and Memory usage

### Regular Maintenance

- Review logs weekly
- Clean up old reports monthly
- Update Node.js packages quarterly
- Backup database daily

## Support and Documentation

- **Application Documentation**: See README.md
- **API Documentation**: See API.md
- **Configuration Guide**: See .env.example
- **Troubleshooting**: See logs/app.log

## Uninstallation

### Remove Windows Service

```cmd
nssm remove HistorianReports confirm
```

### Remove Application

1. Stop the application
2. Delete the application directory
3. Remove from Programs and Features (if installed as MSI)

## Next Steps

1. Access the application at `http://localhost:3000`
2. Log in with admin credentials
3. Configure database connection
4. Set up email (optional)
5. Create user accounts
6. Configure report settings
7. Start generating reports

## Additional Resources

- Node.js Documentation: https://nodejs.org/docs/
- SQL Server Documentation: https://docs.microsoft.com/sql/
- Express.js Guide: https://expressjs.com/
- React Documentation: https://react.dev/

---

**Version**: 1.0  
**Last Updated**: January 2026  
**Compatibility**: Windows 10+, Windows Server 2016+
