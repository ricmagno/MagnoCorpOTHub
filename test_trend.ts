import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';

function testTrend() {
    const hstPath = '/Users/ricmagno/Documents/Projects/KagomeReports/DataFormatExample/Trend/BR_WQ001_PV.HST';
    const hstBuffer = fs.readFileSync(hstPath);
    
    const title = iconv.decode(hstBuffer.slice(0, 128), 'latin1').split('\r\n')[3]?.trim() || '';
    console.log('Title:', title);

    let offset = 128;
    const id = hstBuffer.toString('latin1', offset, offset + 8).replace(/\0/g, '');
    console.log('Master ID:', id);
    offset += 8;

    const type = hstBuffer.readUInt16LE(offset);
    offset += 2;
    const version = hstBuffer.readUInt16LE(offset);
    console.log('Type:', type, 'Version:', version);
    offset += 2;

    offset += 8; // Mode/Alignment
    const maxNrFiles = hstBuffer.readUInt16LE(offset);
    offset += 2;
    const filesCreated = hstBuffer.readUInt16LE(offset);
    console.log('Files Created:', filesCreated);
    offset += 2;

    offset += 24; // Other master fields

    for (let i = 0; i < filesCreated; i++) {
        console.log(`--- File ${i} at offset ${offset} ---`);
        if (version === 6) {
            const fileName = iconv.decode(hstBuffer.slice(offset, offset + 272), 'latin1').replace(/\0/g, '');
            offset += 272;
            
            const fileId = hstBuffer.toString('latin1', offset, offset + 8).replace(/\0/g, '');
            console.log('  File ID:', fileId);
            offset += 8;
            
            const fileType = hstBuffer.readUInt16LE(offset);
            offset += 2;
            const fileVersion = hstBuffer.readUInt16LE(offset);
            offset += 2;
            console.log('  FileVersion:', fileVersion);

            offset += 8; // StartEvNo
            offset += 12; // Align
            const logName = iconv.decode(hstBuffer.slice(offset, offset + 80), 'latin1').replace(/\0/g, '');
            offset += 80;
            offset += 10; // Mode etc
            const samplePeriod = hstBuffer.readUInt32LE(offset);
            offset += 4;
            offset += 12; // EngUnits etc
            const fileTime = hstBuffer.readBigUInt64LE(offset);
            const startTime = new Date(Number((fileTime / BigInt(10000)) - BigInt(11644473600000)));
            offset += 8;
            offset += 8; // EndTime
            const dataLength = hstBuffer.readUInt32LE(offset);
            offset += 4;
            offset += 22; // FilePointer etc
            
            console.log('  File:', path.basename(fileName), 'Start:', startTime.toISOString(), 'Period:', samplePeriod, 'Length:', dataLength);
        } else {
            // Version 5
            const fileName = iconv.decode(hstBuffer.slice(offset, offset + 144), 'latin1').replace(/\0/g, '');
            offset += 144;
            const fileId = hstBuffer.toString('latin1', offset, offset + 8).replace(/\0/g, '');
            offset += 8;
            offset += 2; // Type
            offset += 2; // Version
            offset += 4; // StartEvNo
            const logName = iconv.decode(hstBuffer.slice(offset, offset + 80), 'latin1').replace(/\0/g, '');
            offset += 80;
            offset += 10; // Mode etc
            const samplePeriod = hstBuffer.readUInt32LE(offset);
            offset += 4;
            offset += 12; // EngUnits etc
            const startTime = new Date(hstBuffer.readUInt32LE(offset) * 1000);
            offset += 4;
            offset += 4; // EndTime
            const dataLength = hstBuffer.readUInt32LE(offset);
            offset += 4;
            offset += 10; // FilePointer etc
            console.log('  File:', path.basename(fileName), 'Start:', startTime.toISOString(), 'Period:', samplePeriod, 'Length:', dataLength);
        }
    }
}

testTrend();
