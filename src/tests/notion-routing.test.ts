import { describe, expect, it } from "vitest";
import { isMtCadenceTitle } from "../lib/notion/routing";

describe("isMtCadenceTitle", () => {
    it("matches MT as a standalone token", () => {
        expect(isMtCadenceTitle("MT-overleg")).toBe(true);
        expect(isMtCadenceTitle("MT monthly nov")).toBe(true);
        expect(isMtCadenceTitle("Maandelijkse MT")).toBe(true);
    });
    it("matches the English cadence words as whole words, case-insensitively", () => {
        expect(isMtCadenceTitle("Monthly recap")).toBe(true);
        expect(isMtCadenceTitle("Q3 Quarterly")).toBe(true);
        expect(isMtCadenceTitle("yearly planning")).toBe(true);
        expect(isMtCadenceTitle("UNBOUND sessie")).toBe(true);
    });
    it("routes ordinary meetings to Master", () => {
        expect(isMtCadenceTitle("Commercieel overleg")).toBe(false);
        expect(isMtCadenceTitle("format update")).toBe(false); // substring 'mt' not a word
        expect(isMtCadenceTitle("commitment call")).toBe(false);
    });
    it("does not match the Dutch 'jaar' family", () => {
        expect(isMtCadenceTitle("Voorjaarsoverleg")).toBe(false);
        expect(isMtCadenceTitle("najaarsaanbieding bespreken")).toBe(false);
    });
    it("handles empty/missing titles", () => {
        expect(isMtCadenceTitle("")).toBe(false);
        expect(isMtCadenceTitle("   ")).toBe(false);
        expect(isMtCadenceTitle(null)).toBe(false);
        expect(isMtCadenceTitle(undefined)).toBe(false);
    });
    it("accepts the known false positive (per spec decision)", () => {
        expect(isMtCadenceTitle("SR <> BB quarterly preps")).toBe(true);
    });
});
