function isIPAddress(host) {
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    return ipv4Regex.test(host) || ipv6Regex.test(host);
}

const host = '192.168.235.17';
console.log(`Host: ${host}`);
console.log(`isIPAddress: ${isIPAddress(host)}`);
console.log(`!isIPAddress: ${!isIPAddress(host)}`);
console.log(`encrypt logic: ${true && !isIPAddress(host)}`);
