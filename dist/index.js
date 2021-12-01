"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const dns = require("dns");
const net = require("net");
class EmailDnsValidator {
    constructor(configParam = {}) {
        this.defaultConfig = {
            a: 1,
            ns: 100,
            spf: 10,
            mx: 100,
            port: 10,
            validScore: 310,
            smtpPorts: [25, 465, 587],
        };
        this.config = this.defaultConfig;
        this.email = '';
        this.domain = '';
        let key;
        for (key in configParam) {
            this.config[key] = configParam[key];
        }
    }
    validateDNS() {
        return __awaiter(this, void 0, void 0, function* () {
            let dnsValidationFail = false;
            let score = 0;
            const promises = [];
            if (this.config.ns !== -1) {
                promises.push(this.getNsRecord()
                    .then((addresses) => {
                    if (addresses.length) {
                        score += this.config.ns;
                    }
                })
                    .catch((err) => {
                    dnsValidationFail = true;
                    console.error('ERROR GETTING NS: ', err);
                }));
            }
            if (this.config.mx !== -1) {
                promises.push(this.getMxRecord()
                    .then((addresses) => {
                    if (addresses.length) {
                        score += this.config.mx;
                        if (this.config.port !== -1) {
                            for (let p = 0; p < this.config.smtpPorts.length; p++) {
                                const port = this.config.smtpPorts[p];
                                for (let a = 0; a < addresses.length; a++) {
                                    const host = addresses[a].exchange;
                                    promises.push(this.isPortReachable(port, { host })
                                        .then((reachable) => {
                                        if (reachable) {
                                            score += this.config.port;
                                        }
                                    })
                                        .catch((err) => console.error('ERROR REACHING PORT: ', err)));
                                }
                            }
                        }
                    }
                })
                    .catch((err) => {
                    dnsValidationFail = true;
                    console.error('ERROR GETTING MX: ', err);
                }));
            }
            if (this.config.spf !== -1) {
                promises.push(this.getTxtRecord()
                    .then((addresses) => {
                    for (let a = 0; a < addresses.length; a++) {
                        const address = addresses[a];
                        if (address.indexOf('spf') !== -1) {
                            score += this.config.spf;
                            break;
                        }
                    }
                })
                    .catch((err) => {
                    console.error('ERROR GETTING TXT: ', err);
                }));
            }
            if (this.config.a !== -1) {
                promises.push(this.getARecord()
                    .then((addresses) => {
                    if (addresses.length) {
                        score += this.config.a;
                    }
                })
                    .catch((err) => {
                    console.error('ERROR GETTING A: ', err);
                }));
            }
            yield Promise.all(promises);
            if (dnsValidationFail) {
                return false;
            }
            if (this.config.validScore <= score) {
                return true;
            }
            else {
                return false;
            }
        });
    }
    getNsRecord() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                if (dns) {
                    dns.resolve(this.domain, 'NS', (err, addresses) => __awaiter(this, void 0, void 0, function* () {
                        if (err) {
                            console.error(this.domain, ' has no NS');
                            reject();
                        }
                        else if (addresses) {
                            resolve(addresses);
                        }
                        else {
                            reject();
                        }
                    }));
                }
                else {
                    console.error('"dns" is undefined.');
                    reject();
                }
            });
        });
    }
    getARecord() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                if (dns) {
                    dns.resolve(this.domain, 'A', (err, addresses) => __awaiter(this, void 0, void 0, function* () {
                        if (err) {
                            console.error(this.domain, ' has no NS');
                            reject();
                        }
                        else if (addresses) {
                            resolve(addresses);
                        }
                        else {
                            reject();
                        }
                    }));
                }
                else {
                    console.error('"dns" is undefined.');
                    reject();
                }
            });
        });
    }
    getMxRecord() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                if (dns) {
                    dns.resolve(this.domain, 'MX', (err, addresses) => __awaiter(this, void 0, void 0, function* () {
                        if (err) {
                            console.error(this.domain, ' has no MX');
                            reject();
                        }
                        else if (addresses) {
                            resolve(addresses);
                        }
                        else {
                            reject();
                        }
                    }));
                }
                else {
                    console.error('"dns" is undefined.');
                    reject();
                }
            });
        });
    }
    getTxtRecord() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                if (dns) {
                    dns.resolve(this.domain, 'TXT', (err, addresses) => __awaiter(this, void 0, void 0, function* () {
                        if (err) {
                            console.error(this.domain, ' has no TXT');
                            reject();
                        }
                        else if (addresses) {
                            resolve(addresses);
                        }
                        else {
                            reject();
                        }
                    }));
                }
                else {
                    console.error('"dns" is undefined.');
                    reject();
                }
            });
        });
    }
    isPortReachable(port, { host, timeout = 500 }) {
        return __awaiter(this, void 0, void 0, function* () {
            const promise = new Promise((resolve, reject) => {
                if (net) {
                    const socket = new net.Socket();
                    const onError = () => {
                        socket.destroy();
                        reject();
                    };
                    socket.setTimeout(timeout);
                    socket.once('error', onError);
                    socket.once('timeout', onError);
                    socket.connect(port, host, () => {
                        socket.end();
                        resolve(true);
                    });
                }
                else {
                    console.error('"net" is undefined.');
                    reject();
                }
            });
            try {
                yield promise;
                return true;
            }
            catch (_a) {
                return false;
            }
        });
    }
    setEmailDetails(email) {
        if (typeof email !== 'string') {
            console.error('Email not a string.', email);
            return false;
        }
        else if (!email) {
            console.error('Email not provided.', email);
            return false;
        }
        this.email = email.trim();
        this.domain = this.email.slice(this.email.indexOf('@') + 1).toLowerCase();
    }
    validate(email) {
        return __awaiter(this, void 0, void 0, function* () {
            const setEmailResults = this.setEmailDetails(email);
            if (setEmailResults === false) {
                return false;
            }
            return yield this.validateDNS();
        });
    }
    isGSuiteMX(email) {
        return __awaiter(this, void 0, void 0, function* () {
            const setEmailResults = this.setEmailDetails(email);
            if (setEmailResults === false) {
                return false;
            }
            let isGSuite = false;
            try {
                const addresses = yield this.getMxRecord();
                if (addresses) {
                    for (let a = 0; a < addresses.length; a++) {
                        const address = addresses[a];
                        const domain = address.exchange.toLowerCase();
                        if (domain.indexOf('aspmx.l.google.com') !== -1) {
                            isGSuite = true;
                        }
                    }
                }
            }
            catch (getMxRecordErr) {
                console.error('ERROR GETTING MX in isGSuiteMX: ', getMxRecordErr);
            }
            return isGSuite;
        });
    }
    isDefaultNamecheapMX(email) {
        return __awaiter(this, void 0, void 0, function* () {
            const setEmailResults = this.setEmailDetails(email);
            if (setEmailResults === false) {
                return false;
            }
            let isDefaultNamecheapMX = false;
            try {
                const addresses = yield this.getMxRecord();
                if (addresses) {
                    for (let a = 0; a < addresses.length; a++) {
                        const address = addresses[a];
                        const domain = address.exchange.toLowerCase();
                        if (domain.indexOf('registrar-servers.com') !== -1) {
                            isDefaultNamecheapMX = true;
                        }
                    }
                }
            }
            catch (getMxRecordErr) {
                console.error('ERROR GETTING MX in isDefaultNamecheapMX: ', getMxRecordErr);
            }
            return isDefaultNamecheapMX;
        });
    }
}
exports.default = EmailDnsValidator;
//# sourceMappingURL=index.js.map